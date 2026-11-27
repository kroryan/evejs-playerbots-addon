"use strict";

const corporations = require("../corporation/corporationState");
const { effectiveCorporationMemberLimit, hasRoomForAnotherMember } = require("../corporation/corporationMemberLimit");
const { readSharedCharacterRecord } = require("../character/characterState");
const { getPlayerBotLoadController } = require("./playerBotLoadController");
const log = require("../../utils/logger");

const configuredBatchSize = Number(process.env.EVEJS_PLAYER_BOTS_RECRUITMENT_BATCH_SIZE || 4);
const BATCH_SIZE = Number.isInteger(configuredBatchSize) && configuredBatchSize >= 1 && configuredBatchSize <= 16
  ? configuredBatchSize : 4;
const BATCH_DELAY_MS = 150;
const LOAD_BACKOFF_MS = 1_000;
const AUTO_INTERVAL_MS = 120_000;
let activeJob = null;
let lastResult = "";
let batchTimer;
let autoTimer;
let lastAutoError = "";
let automaticPaused = false;

function resolveTarget(value) {
  const selector = String(value || "").trim();
  if (!selector) {
    return { error: "No target corporation set. In the Launcher use Mods > Configure > Target corporation; " +
      "on Docker set EVEJS_PLAYER_BOTS_RECRUITMENT_CORPORATION in .env and restart the server." };
  }
  const prefix = /^(name|ticker):\s*/i.exec(selector);
  const query = prefix ? selector.slice(prefix[0].length).trim() : selector;
  const mode = prefix?.[1].toLowerCase();
  const byName = mode === "ticker" ? null : corporations.findCorporationByName(query);
  const byTicker = mode === "name" ? null : corporations.findCorporationByTickerName(query);
  if (byName && byTicker && Number(byName.corporationID) !== Number(byTicker.corporationID)) {
    return { error: "Target corporation matches both a name and a ticker. Use name: or ticker: in Launcher." };
  }
  const corporation = byName || byTicker;
  if (!corporation || corporation.deleted || corporation.isNPC !== false ||
      corporations.isNpcCorporationID(corporation.corporationID)) {
    return { error: `No player corporation matches "${selector}". Check Target corporation in Launcher.` };
  }
  const current = corporations.getCorporationRecord(corporation.corporationID);
  return current ? { corporation: current } : { error: "The target corporation is no longer available." };
}

function describeJob(job) {
  const checked = job.cursor;
  const unprocessed = job.candidates.length - checked;
  const failures = job.firstFailure ? ` First failure: ${job.firstFailure}` : "";
  return `${job.label}: ${job.joined} joined, ${job.alreadyMembers} already in the corporation, ` +
    `${job.skipped} ineligible, ${job.failed} failed, ${unprocessed} not processed.${failures}`;
}

function finish(job, reason = "", notifyRequester = true) {
  activeJob = null;
  const result = `Playerbot recruitment complete. ${describeJob(job)}${reason ? ` ${reason}` : ""}`;
  if (job.notify || job.joined || job.failed || !lastResult) lastResult = result;
  if (job.notify && notifyRequester) {
    try { job.notify(result); } catch (error) {
      log.warn(`[PlayerBots] Could not send recruitment status: ${error.message}`);
    }
  }
  if (job.joined || job.failed || job.notify) log.info(`[PlayerBots] ${result}`);
  return result;
}

function schedule(job, delay = BATCH_DELAY_MS) {
  batchTimer = setTimeout(() => {
    batchTimer = undefined;
    try {
      runBatch(job);
    } catch (error) {
      log.warn(`[PlayerBots] Corporation recruitment stopped: ${error.message}`);
      finish(job, "Recruitment stopped after a server error.");
    }
  }, delay);
  batchTimer.unref();
}

function eligibleSource(job, bot, character) {
  if (!character || character.isDeleted || character.deletedAt || bot.wildfire) return false;
  const sourceID = Number(character.corporationID);
  if (corporations.isNpcCorporationID(sourceID)) return true;
  if (sourceID !== Number(bot.specialtyCorporationID) || bot.founder) return false;
  const source = corporations.getCorporationRecord(sourceID);
  if (!source || source.deleted || !job.playerBots.hasBotProfile(source.ceoID)) return false;
  const members = corporations.getCharacterIDsInCorporation(sourceID);
  return members.length > job.playerBots.MIN_BOTS_PER_CORPORATION &&
    members.every((characterID) => job.playerBots.hasBotProfile(characterID));
}

function runBatch(job) {
  if (activeJob !== job) return;
  if (getPlayerBotLoadController().shouldPauseLowPriorityWork()) return schedule(job, LOAD_BACKOFF_MS);
  const target = corporations.getCorporationRecord(job.corporationID);
  if (target?.deleted || target?.isNPC !== false ||
      job.playerBots.hasBotProfile(target.ceoID) ||
      !job.service.canManageRecruitment(job.corporationID, job.session)) {
    return finish(job, "Recruitment authority is no longer available.");
  }
  let memberCount = Number(target.memberCount) || 0;
  const botLimit = job.playerBots.MAX_BOTS_PER_PLAYER_CORPORATION;
  const memberLimit = effectiveCorporationMemberLimit(target);
  const countBotsSeparately = !(memberLimit >= 0 && memberLimit <= botLimit);

  if (countBotsSeparately) job.targetBots = job.playerBots.countBotsInCorporation(job.corporationID);
  const end = Math.min(job.cursor + BATCH_SIZE, job.candidates.length);
  for (; job.cursor < end; job.cursor += 1) {
    if (countBotsSeparately && job.targetBots >= botLimit) {
      return finish(job, "Playerbot limit reached.");
    }
    if (!hasRoomForAnotherMember(memberLimit, memberCount)) {
      return finish(job, "Corporation member limit reached.");
    }
    const id = job.candidates[job.cursor];
    const bot = job.playerBots.getBotByCharacterID(id);
    if (!bot) { job.skipped += 1; continue; }
    const character = readSharedCharacterRecord(id);
    if (Number(character?.corporationID) === job.corporationID) {
      job.alreadyMembers += 1;
    } else if (!eligibleSource(job, bot, character)) {
      job.skipped += 1;
    } else {
      const result = job.playerBots.acceptBotCorporationInvitation(job.service, job.session, bot, job.corporationID);
      if (result.success) {
        job.targetBots += 1;
        job.joined += 1;
        memberCount += 1;
      } else if (result.ineligible) {
        job.skipped += 1;
      } else {
        job.failed += 1;
        job.firstFailure ||= result.message;
      }
    }
  }
  if (job.cursor < job.candidates.length) return schedule(job);
  return finish(job);
}

function startRecruits(corporation, session, { notify, action = "", manual = false } = {}) {
  const corporationID = Number(corporation.corporationID);
  const Service = require("../corporation/corpRegistryRuntime");
  const service = new Service();
  if (!service.canManageRecruitment(corporationID, session)) {
    return "Only the target corporation's CEO, directors, and personnel managers can invite its bots.";
  }
  const playerBots = require("./playerBotRuntime");
  if (playerBots.hasBotProfile(corporation.ceoID)) {
    return "Target corporation must have a player CEO.";
  }
  if (action === "status") {
    if (automaticPaused) return `${lastResult || "Playerbot recruitment paused."} Use /bots corp inviteall to resume.`;
    return activeJob?.corporationID === corporationID ? `Playerbot recruitment in progress. ${describeJob(activeJob)}` :
      lastResult || "No Playerbot corporation recruitment run in this Game session.";
  }
  if (action === "cancel") {
    automaticPaused = process.env.EVEJS_PLAYER_BOTS_AUTO_RECRUIT_CORPORATION === "1";
    const note = automaticPaused ? " Automatic recruitment is paused until a new manual run or Game restart." : "";
    if (activeJob?.corporationID !== corporationID) return `No recruitment batch is running.${note}`;
    clearTimeout(batchTimer);
    batchTimer = undefined;
    return finish(activeJob, `Recruitment cancelled.${note}`, activeJob.session !== session);
  }
  if (activeJob) return "Playerbot recruitment is already running. Use /bots corp inviteall status.";
  if (!hasRoomForAnotherMember(effectiveCorporationMemberLimit(corporation), corporation.memberCount)) {
    return "The target corporation has reached its member limit.";
  }
  const members = new Set(corporations.getCharacterIDsInCorporation(corporationID).map(Number));
  const candidates = [];
  let targetBots = 0;
  for (const profile of playerBots.listBotProfiles()) {
    const id = Number(profile.characterID);
    if (members.has(id)) targetBots += 1;
    else candidates.push(id);
  }
  if (!candidates.length) return "There are no other managed playerbots to recruit.";
  if (targetBots >= playerBots.MAX_BOTS_PER_PLAYER_CORPORATION) return "The target corporation has reached its playerbot limit.";
  activeJob = {
    label: `${corporation.corporationName} [${corporation.tickerName}]`,
    corporationID, playerBots, service, session, notify, candidates, targetBots,
    cursor: 0, joined: 0, alreadyMembers: targetBots, skipped: 0, failed: 0,
  };
  if (manual) automaticPaused = false;
  schedule(activeJob);
  return `Playerbot recruitment queued for ${activeJob.label}. Checking ${candidates.length} managed pilots. Use /bots corp inviteall status.`;
}

// Without a configured target, a manual inviteall fills the caller's own player corporation.
function resolveManualTarget(session) {
  if (String(process.env.EVEJS_PLAYER_BOTS_RECRUITMENT_CORPORATION || "").trim()) {
    return resolveTarget(process.env.EVEJS_PLAYER_BOTS_RECRUITMENT_CORPORATION);
  }
  const corporationID = Number(session?.corporationID || session?.corpid || 0);
  const corporation = corporationID && !corporations.isNpcCorporationID(corporationID)
    ? corporations.getCorporationRecord(corporationID) : null;
  if (corporation && !corporation.deleted && corporation.isNPC === false) return { corporation };
  return resolveTarget("");
}

function inviteAll(session, notify, action = "") {
  const target = resolveManualTarget(session);
  return target.error || startRecruits(target.corporation, session, { notify, action: action === true ? "status" : action, manual: true });
}

function startAutomaticRecruitment() {
  if (autoTimer || process.env.EVEJS_PLAYER_BOTS_AUTO_RECRUIT_CORPORATION !== "1") return;
  autoTimer = setInterval(() => {
    if (activeJob || automaticPaused || getPlayerBotLoadController().shouldPauseLowPriorityWork()) return;
    try {
      const target = resolveTarget(process.env.EVEJS_PLAYER_BOTS_RECRUITMENT_CORPORATION);
      if (target.error) throw new Error(target.error);
      // The server operator opted in for this specific corporation. Use its
      // current CEO, with the same persisted-authority checks as manual invites.
      const { corporationID, ceoID } = target.corporation;
      startRecruits(target.corporation, { characterID: Number(ceoID), corporationID: Number(corporationID) });
      lastAutoError = "";
    } catch (error) {
      if (lastAutoError === error.message) return;
      lastAutoError = error.message;
      log.warn(`[PlayerBots] Automatic corporation recruitment: ${lastAutoError}`);
    }
  }, AUTO_INTERVAL_MS);
  autoTimer.unref();
}

function shutdown() {
  clearTimeout(batchTimer);
  clearInterval(autoTimer);
  batchTimer = undefined;
  autoTimer = undefined;
  activeJob = null;
  automaticPaused = false;
}

module.exports = { inviteAll, startAutomaticRecruitment, shutdown };
