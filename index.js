import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DateTime } from "luxon";

const EVENTS_URL = process.env.EVENTS_URL || "https://en.onepiece-cardgame.com/events/";
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const STATE_FILE = process.env.STATE_FILE || "data/created-discord-events.json";
const MAX_EVENTS_PER_RUN = Number(process.env.MAX_EVENTS_PER_RUN || 10);

const ALLOWED_REGIONS = new Set(
  String(process.env.ALLOWED_REGIONS || "North America")
    .split(",")
    .map((region) => region.trim().toLowerCase())
    .filter(Boolean)
);

const MONTHS = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

function clean(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\u200b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&rsquo;/g, "’")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function absoluteUrl(href, baseUrl = EVENTS_URL) {
  return new URL(href, baseUrl).toString();
}

function stripHtmlToLines(html, baseUrl = EVENTS_URL) {
  const htmlWithLinksPreserved = html.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, inner) => {
      const label = clean(inner.replace(/<[^>]+>/g, " "));
      const url = absoluteUrl(decodeHtml(href), baseUrl);
      return label ? label + " " + url : url;
    }
  );

  const text = decodeHtml(
    htmlWithLinksPreserved
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|tr|td|th)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );

  return text
    .split("\n")
    .map(clean)
    .filter(Boolean);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 OPCG Discord scheduled event checker",
    },
  });

  if (!response.ok) {
    throw new Error("Failed to fetch " + url + ": " + response.status + " " + response.statusText);
  }

  return response.text();
}

function standardRegion(region) {
  const cleaned = clean(region);

  if (/^north america$/i.test(cleaned)) return "North America";
  if (/^europe$/i.test(cleaned)) return "Europe";
  if (/^oceania$/i.test(cleaned)) return "Oceania";
  if (/^latin america$/i.test(cleaned)) return "Latin America";
  if (/^middle east$/i.test(cleaned)) return "Middle East";
  if (/^asia$/i.test(cleaned)) return "Asia";
  if (/^online$/i.test(cleaned)) return "Online";

  return cleaned;
}

function isAllowedRegion(region) {
  return ALLOWED_REGIONS.has(clean(region).toLowerCase());
}

function eventId(event) {
  return crypto
    .createHash("sha256")
    .update("tournament|" + event.title + "|" + event.date + "|" + event.region + "|" + event.venue)
    .digest("hex");
}

function signupEventId(event) {
  return crypto
    .createHash("sha256")
    .update("signup|" + event.title + "|" + event.date + "|" + event.signupGuide + "|" + event.registration)
    .digest("hex");
}

async function readSeenIds() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

async function writeSeenIds(ids) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify([...ids].sort(), null, 2) + "\n");
}

function parseMainEventLinks(html) {
  const links = [];
  const seen = new Set();

  const anchorRegex =
    /<a\b[^>]*href=["']([^"']*\/events\/[^"']+\.html|[^"']+\.html)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    const href = match[1];
    const inner = match[2];

    const url = absoluteUrl(href);

    if (!url.includes("/events/")) continue;
    if (url.endsWith("/events/")) continue;
    if (seen.has(url)) continue;

    const text = clean(stripHtmlToLines(inner).join(" "));
    if (!text || /view all events|past events/i.test(text)) continue;

    seen.add(url);
    links.push({ url, text });
  }

  return links;
}

function parseTitleFromDetail(html, fallbackText, detailUrl) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  if (titleMatch) {
    const title = clean(
      decodeHtml(titleMatch[1])
        .replace("| ONE PIECE CARD GAME - Official Web Site", "")
        .replace("｜ONE PIECE CARD GAME - Official Web Site", "")
    );

    if (title) return title;
  }

  return clean(fallbackText.replace(/Event Period:.*$/i, "")) || detailUrl;
}

function parseApplicationInfo(lines) {
  const monthSignupDates = {};
  const regionSignupTimes = {};

  const startIndex = lines.findIndex((line) => /^Application Period$/i.test(line));
  if (startIndex === -1) return { monthSignupDates, regionSignupTimes };

  const stopRegex =
    /^(Prize|Side Event|Tournament Rules|Notes|Important Notes|Products|VIEW ALL EVENTS)$/i;

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];

    if (stopRegex.test(line)) break;

    const monthMatch = line.match(/^For\s+(.+?)\s+Events?:\s*(.+)$/i);
    if (monthMatch) {
      monthSignupDates[clean(monthMatch[1])] = clean(monthMatch[2]);
      continue;
    }

    const regionMatch = line.match(
      /^(North America|Europe|Oceania|Latin America|Middle East|Asia|Online):\s*(.+)$/i
    );

    if (regionMatch) {
      regionSignupTimes[standardRegion(regionMatch[1])] = clean(regionMatch[2]);
    }
  }

  return { monthSignupDates, regionSignupTimes };
}

function getFirstMonthFromDate(dateText) {
  const match = String(dateText || "").match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i
  );

  if (!match) return "";
  return match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
}

function getSignupGuide(event, applicationInfo) {
  const month = getFirstMonthFromDate(event.date);
  const signupDate = applicationInfo.monthSignupDates[month] || "";
  const signupTime = applicationInfo.regionSignupTimes[event.region] || "";

  if (signupDate && signupTime) return signupDate + " at " + signupTime;
  if (signupDate) return signupDate;
  if (signupTime) return signupTime;

  return "";
}

function parseDetailedSchedule(html, pageTitle, detailUrl) {
  const lines = stripHtmlToLines(html, detailUrl);
  const applicationInfo = parseApplicationInfo(lines);
  const events = [];

  const startIndex = lines.findIndex((line) =>
    /Event Schedule and Tournament Organizer/i.test(line)
  );

  if (startIndex === -1) return events;

  const stopRegex =
    /^(Advanced Application Method|Application Period|Prize|Side Event|Tournament Rules|Notes|Important Notes|Products|VIEW ALL EVENTS)$/i;

  const regionRegex =
    /^(North America|Europe|Oceania|Latin America|Middle East|Asia|Online)$/i;

  let currentRegion = "";
  let currentOrganizer = "";

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];

    if (stopRegex.test(line)) break;

    if (regionRegex.test(line)) {
      currentRegion = standardRegion(line);
      currentOrganizer = "";
      continue;
    }

    if (/^Date:/i.test(line)) {
      const date = clean(line.replace(/^Date:\s*/i, ""));
      let venue = "";
      let registration = "";

      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];

        if (stopRegex.test(next)) break;
        if (regionRegex.test(next)) break;
        if (/^Date:/i.test(next)) break;

        if (/^Venue:/i.test(next)) {
          venue = clean(next.replace(/^Venue:\s*/i, ""));
        } else if (/^Link:/i.test(next)) {
          registration = clean(next.replace(/^Link:\s*/i, ""));
        }
      }

      const event = {
        title: currentOrganizer ? pageTitle + " - " + currentOrganizer : pageTitle,
        date,
        venue,
        region: currentRegion,
        registration,
        signupGuide: "",
        source: detailUrl,
      };

      event.signupGuide = getSignupGuide(event, applicationInfo);
      events.push(event);
      continue;
    }

    if (
      line &&
      !/^Overview$/i.test(line) &&
      !/^Period$/i.test(line) &&
      !/^Format$/i.test(line) &&
      !/^Regulation$/i.test(line) &&
      !/^Date:/i.test(line) &&
      !/^Venue:/i.test(line) &&
      !/^Link:/i.test(line)
    ) {
      currentOrganizer = line;
    }
  }

  return events;
}

function normalizeEventFields(event) {
  let date = clean(event.date);
  let venue = clean(event.venue);
  let registration = clean(event.registration);

  const venueFromDate = date.match(/\s+Venue:\s*(.*?)(?:\s+Link:\s*|$)/i);
  if (!venue && venueFromDate) {
    venue = clean(venueFromDate[1]);
  }

  const linkFromDate = date.match(/\s+Link:\s*(.*)$/i);
  if (!registration && linkFromDate) {
    registration = clean(linkFromDate[1]);
  }

  date = clean(date.replace(/\s+Venue:.*$/i, "").replace(/\s+Link:.*$/i, ""));

  const linkFromVenue = venue.match(/\s+Link:\s*(.*)$/i);
  if (linkFromVenue) {
    if (!registration) registration = clean(linkFromVenue[1]);
    venue = clean(venue.replace(/\s+Link:.*$/i, ""));
  }

  return {
    ...event,
    date,
    venue,
    registration,
  };
}

function guessTimeZoneFromVenue(venue) {
  const v = String(venue || "").toUpperCase();

  if (/\b(CA|WA|OR|NV|BC)\b/.test(v)) return "America/Los_Angeles";
  if (/\bAB\b/.test(v)) return "America/Edmonton";
  if (/\bAZ\b/.test(v)) return "America/Phoenix";
  if (/\bCO|UT|NM|WY|MT\b/.test(v)) return "America/Denver";

  if (/\bTX|OK|IL|IN|WI|MN|MO|LA|AR|IA|KS|NE|TN|MS|AL\b/.test(v)) {
    return "America/Chicago";
  }

  if (/\bFL|VA|ON|QC|NY|NC|SC|GA|PA|OH|MI|MA|MD|NJ\b/.test(v)) {
    return "America/New_York";
  }

  return "America/Los_Angeles";
}

function parseDateRange(dateText, venue) {
  const text = clean(dateText);
  const yearMatch = text.match(/\b(20\d{2})\b/);

  const monthMatches = [
    ...text.matchAll(
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/gi
    ),
  ];

  if (!yearMatch || monthMatches.length === 0) return null;

  const year = Number(yearMatch[1]);
  const startMonthName = monthMatches[0][1].toLowerCase();
  const startMonth = MONTHS[startMonthName];

  const afterStartMonth = text.slice(monthMatches[0].index + monthMatches[0][0].length);
  const startDayMatch = afterStartMonth.match(/\s+(\d{1,2})/);

  if (!startDayMatch) return null;

  const startDay = Number(startDayMatch[1]);

  let endMonth = startMonth;
  let endDay = startDay;

  if (monthMatches.length >= 2) {
    endMonth = MONTHS[monthMatches[1][1].toLowerCase()];

    const afterEndMonth = text.slice(monthMatches[1].index + monthMatches[1][0].length);
    const endDayMatch = afterEndMonth.match(/\s+(\d{1,2})/);

    if (endDayMatch) {
      endDay = Number(endDayMatch[1]);
    }
  } else {
    const rangeMatch = text.match(
      /\b[A-Za-z]+\s+(\d{1,2})\s*[-–]\s*(\d{1,2})\s*,?\s*20\d{2}/
    );

    if (rangeMatch) {
      endDay = Number(rangeMatch[2]);
    }
  }

  const zone = guessTimeZoneFromVenue(venue);

  return {
    start: DateTime.fromObject(
      { year, month: startMonth, day: startDay, hour: 10, minute: 0 },
      { zone }
    ),
    end: DateTime.fromObject(
      { year, month: endMonth, day: endDay, hour: 20, minute: 0 },
      { zone }
    ),
    zone,
  };
}

function parseSignupDateTime(signupGuide) {
  const text = clean(signupGuide);

  const dateMatch = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2}\b/i
  );

  if (!dateMatch) return null;

  const timeMatch = text.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)\s*(PDT|PT|PST)\b/i);

  if (!timeMatch) return null;

  const datePart = dateMatch[0].replace(",", "");
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const ampm = timeMatch[3].toLowerCase();

  if (ampm === "pm" && hour !== 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;

  const parsed = DateTime.fromFormat(datePart, "LLLL d yyyy", {
    zone: "America/Los_Angeles",
  }).set({ hour, minute });

  if (!parsed.isValid) return null;

  return parsed;
}

function isFutureOrUpcomingEvent(event) {
  const range = parseDateRange(event.date, event.venue);
  if (!range) return false;

  const today = DateTime.now().startOf("day");
  return range.end >= today;
}

function shouldCreateSignupEvent(event) {
  if (!event.signupGuide) return false;

  const signupDateTime = parseSignupDateTime(event.signupGuide);
  if (!signupDateTime) return false;

  return signupDateTime >= DateTime.now();
}

function compareEventsChronologically(a, b) {
  const rangeA = parseDateRange(a.date, a.venue);
  const rangeB = parseDateRange(b.date, b.venue);

  if (rangeA && rangeB) {
    return rangeA.start.toMillis() - rangeB.start.toMillis();
  }

  if (rangeA && !rangeB) return -1;
  if (!rangeA && rangeB) return 1;

  return (a.title + " " + a.venue).localeCompare(b.title + " " + b.venue);
}

async function scrapeEvents() {
  const mainHtml = await fetchText(EVENTS_URL);
  const links = parseMainEventLinks(mainHtml);

  console.log("Found " + links.length + " official event pages.");

  const allEvents = [];

  for (const link of links) {
    try {
      const detailHtml = await fetchText(link.url);
      const pageTitle = parseTitleFromDetail(detailHtml, link.text, link.url);
      const detailedEvents = parseDetailedSchedule(detailHtml, pageTitle, link.url);

      allEvents.push(...detailedEvents);
    } catch (error) {
      console.log("Could not parse " + link.url + ": " + error.message);
    }
  }

  const filteredEvents = allEvents
    .map(normalizeEventFields)
    .filter((event) => event.region && isAllowedRegion(event.region))
    .filter((event) => event.venue && isFutureOrUpcomingEvent(event))
    .sort(compareEventsChronologically);

  const byId = new Map();

  for (const event of filteredEvents) {
    byId.set(eventId(event), event);
  }

  return [...byId.values()];
}

async function getExistingDiscordEvents() {
  const response = await fetch(
    "https://discord.com/api/v10/guilds/" + DISCORD_GUILD_ID + "/scheduled-events",
    {
      headers: {
        Authorization: "Bot " + DISCORD_BOT_TOKEN,
      },
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");

    throw new Error(
      "Could not fetch Discord events: " + response.status + " " + response.statusText + " " + body
    );
  }

  return response.json();
}

function payloadKey(payload) {
  const name = clean(payload.name).toLowerCase();
  const date = DateTime.fromISO(payload.scheduled_start_time).toUTC().toISODate();
  const location = clean(payload.entity_metadata?.location || "").toLowerCase();

  return name + "|" + date + "|" + location;
}

function buildExistingDiscordEventKeys(existingDiscordEvents) {
  return new Set(
    existingDiscordEvents.map((event) => {
      const name = clean(event.name).toLowerCase();
      const date = DateTime.fromISO(event.scheduled_start_time).toUTC().toISODate();
      const location = clean(event.entity_metadata?.location || "").toLowerCase();

      return name + "|" + date + "|" + location;
    })
  );
}

function buildDiscordTournamentEventPayload(event) {
  const range = parseDateRange(event.date, event.venue);

  if (!range) {
    throw new Error("Could not parse event date: " + event.date);
  }

  const description = [
    event.date ? "Date: " + event.date : "",
    event.signupGuide ? "Sign-up guide: " + event.signupGuide : "",
    event.registration ? "Registration: " + event.registration : "",
    event.source ? "Source: " + event.source : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    name: event.title.slice(0, 100),
    privacy_level: 2,
    scheduled_start_time: range.start.toUTC().toISO(),
    scheduled_end_time: range.end.toUTC().toISO(),
    description: description.slice(0, 1000),
    entity_type: 3,
    channel_id: null,
    entity_metadata: {
      location: event.venue.slice(0, 100),
    },
  };
}

function buildDiscordSignupEventPayload(event) {
  const signupDateTime = parseSignupDateTime(event.signupGuide);

  if (!signupDateTime) {
    throw new Error("Could not parse sign-up guide: " + event.signupGuide);
  }

  const start = signupDateTime;
  const end = signupDateTime.plus({ hours: 1 });

  const description = [
    "Registration opens for: " + event.title,
    event.date ? "Tournament date: " + event.date : "",
    event.venue ? "Tournament venue: " + event.venue : "",
    event.registration ? "Registration: " + event.registration : "",
    event.source ? "Source: " + event.source : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    name: ("SIGN-UP OPENS: " + event.title).slice(0, 100),
    privacy_level: 2,
    scheduled_start_time: start.toUTC().toISO(),
    scheduled_end_time: end.toUTC().toISO(),
    description: description.slice(0, 1000),
    entity_type: 3,
    channel_id: null,
    entity_metadata: {
      location: "Online registration",
    },
  };
}

async function createDiscordScheduledEventFromPayload(payload) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await fetch(
      "https://discord.com/api/v10/guilds/" + DISCORD_GUILD_ID + "/scheduled-events",
      {
        method: "POST",
        headers: {
          Authorization: "Bot " + DISCORD_BOT_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    if (response.ok) {
      await sleep(4000);
      return response.json();
    }

    const body = await response.text().catch(() => "");

    if (response.status === 429) {
      let retryAfterMs = 10000;

      try {
        const data = JSON.parse(body);
        if (data.retry_after) {
          retryAfterMs = Math.ceil(Number(data.retry_after) * 1000) + 1000;
        }
      } catch {}

      console.log("Discord rate limited. Waiting " + retryAfterMs + "ms, then retrying...");
      await sleep(retryAfterMs);
      continue;
    }

    throw new Error(
      "Could not create Discord scheduled event: " +
        response.status +
        " " +
        response.statusText +
        " " +
        body
    );
  }

  throw new Error("Could not create Discord scheduled event after too many retry attempts.");
}

async function main() {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) {
    throw new Error("Missing DISCORD_BOT_TOKEN or DISCORD_GUILD_ID.");
  }

  const seenIds = await readSeenIds();
  const officialEvents = await scrapeEvents();
  const existingDiscordEvents = await getExistingDiscordEvents();
  const existingDiscordEventKeys = buildExistingDiscordEventKeys(existingDiscordEvents);

  console.log("Found " + officialEvents.length + " future North America official events.");
  console.log("Found " + existingDiscordEvents.length + " existing Discord scheduled events.");

  const jobs = [];

  for (const event of officialEvents) {
    const tournamentId = eventId(event);
    const tournamentPayload = buildDiscordTournamentEventPayload(event);
    const tournamentPayloadKey = payloadKey(tournamentPayload);

    if (seenIds.has(tournamentId) || existingDiscordEventKeys.has(tournamentPayloadKey)) {
      if (existingDiscordEventKeys.has(tournamentPayloadKey)) {
        seenIds.add(tournamentId);
      }
    } else {
      jobs.push({
        type: "tournament",
        id: tournamentId,
        event,
        payload: tournamentPayload,
        startTime: tournamentPayload.scheduled_start_time,
      });
    }

    if (shouldCreateSignupEvent(event)) {
      const signupId = signupEventId(event);
      const signupPayload = buildDiscordSignupEventPayload(event);
      const signupPayloadKey = payloadKey(signupPayload);

      if (seenIds.has(signupId) || existingDiscordEventKeys.has(signupPayloadKey)) {
        if (existingDiscordEventKeys.has(signupPayloadKey)) {
          seenIds.add(signupId);
        }
      } else {
        jobs.push({
          type: "signup",
          id: signupId,
          event,
          payload: signupPayload,
          startTime: signupPayload.scheduled_start_time,
        });
      }
    }
  }

  jobs.sort((a, b) => {
    return DateTime.fromISO(a.startTime).toMillis() - DateTime.fromISO(b.startTime).toMillis();
  });

  const jobsToCreate = jobs.slice(0, MAX_EVENTS_PER_RUN);

  console.log("Creating " + jobsToCreate.length + " Discord scheduled events.");

  for (const job of jobsToCreate) {
    await createDiscordScheduledEventFromPayload(job.payload);
    seenIds.add(job.id);

    if (job.type === "signup") {
      console.log("Created sign-up event: " + job.event.signupGuide + " - " + job.event.title);
    } else {
      console.log("Created tournament event: " + job.event.date + " - " + job.event.title);
    }
  }

  await writeSeenIds(seenIds);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
