exports.handler = async function (event) {
  const sources = [
    process.env.ICAL_URL_AIRBNB,
    process.env.ICAL_URL_BOOKING,
  ].filter(Boolean);

  if (sources.length === 0) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "No iCal URLs configured. Set ICAL_URL_AIRBNB and/or ICAL_URL_BOOKING in Netlify environment variables." }),
    };
  }

  const busyDates = new Set();

  for (const url of sources) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const text = await res.text();
      parseIcal(text, busyDates);
    } catch (e) {
      console.error("Failed to fetch iCal:", url, e.message);
    }
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
    body: JSON.stringify({ busyDates: Array.from(busyDates).sort() }),
  };
};

function parseIcal(text, out) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let inEvent = false;
  let dtStart = null;
  let dtEnd = null;
  let status = null;

  for (const raw of lines) {
    const line = raw.trim();

    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      dtStart = null;
      dtEnd = null;
      status = null;
    } else if (line === "END:VEVENT") {
      if (inEvent && dtStart && status !== "CANCELLED") {
        expandRange(dtStart, dtEnd || dtStart, out);
      }
      inEvent = false;
    } else if (inEvent) {
      if (line.startsWith("DTSTART")) {
        dtStart = extractDate(line);
      } else if (line.startsWith("DTEND")) {
        dtEnd = extractDate(line);
      } else if (line.startsWith("STATUS:")) {
        status = line.split(":")[1];
      }
    }
  }
}

function extractDate(line) {
  // Handles DTSTART;VALUE=DATE:20240101 and DTSTART:20240101T120000Z
  const val = line.split(":").slice(1).join(":");
  return val.substring(0, 8); // YYYYMMDD
}

function expandRange(startStr, endStr, out) {
  const start = parseYMD(startStr);
  const end = parseYMD(endStr);
  const cursor = new Date(start);

  // iCal DTEND is exclusive for all-day events
  while (cursor < end) {
    out.add(toISO(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  // If same day (datetime events), add it anyway
  if (start >= end) {
    out.add(toISO(start));
  }
}

function parseYMD(s) {
  return new Date(
    Date.UTC(
      parseInt(s.substring(0, 4)),
      parseInt(s.substring(4, 6)) - 1,
      parseInt(s.substring(6, 8))
    )
  );
}

function toISO(d) {
  return d.toISOString().substring(0, 10);
}
