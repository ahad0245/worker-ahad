// api/location-bulk-sync.js  (for Vercel standalone)
// or pages/api/location-bulk-sync.js (for Next.js)

/**
 * ENV:
 *  MAIN_API_BASE_URL = https://your-main-api-domain.com
 *  MAIN_API_KEY      = optional bearer token
 */

const MAIN_API_BASE_URL = process.env.MAIN_API_BASE_URL;
const MAIN_API_KEY = process.env.MAIN_API_KEY;

// ---------- Custom checks for each record ----------
function customCheckLocationPayload(payload) {
  if (!payload) return false;

  // Required fields based on your example
  if (!payload.id) return false;
  if (!payload.locationId) return false;

  if (
    typeof payload.latitude !== 'number' ||
    typeof payload.longitude !== 'number'
  ) {
    return false;
  }

  // Avoid garbage coordinates
  if (payload.latitude === 0 && payload.longitude === 0) return false;

  // Optional: if startTime is required (you can relax this if needed)
  if (!payload.startTime) return false;

  return true;
}

// ---------- Call your main API: /api/v1/tracker/updateLocations ----------
async function sendToUpdateLocations(payload) {
  if (!MAIN_API_BASE_URL) {
    throw new Error('MAIN_API_BASE_URL is not configured on worker');
  }

  const url = `${MAIN_API_BASE_URL}/api/v1/tracker/updateLocations`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(MAIN_API_KEY ? { Authorization: `Bearer ${MAIN_API_KEY}` } : {})
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text().catch(() => '');

  if (!res.ok) {
    throw new Error(
      `Main API ${res.status} on updateLocations: ${
        text || res.statusText || 'Unknown error'
      }`
    );
  }

  let json = {};
  try {
    json = JSON.parse(text || '{}');
  } catch {
    json = {};
  }

  return json;
}

// ---------- Vercel Handler ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    if (!MAIN_API_BASE_URL) {
      return res
        .status(500)
        .json({ message: 'MAIN_API_BASE_URL env is required on worker' });
    }

    const { deviceId, records } = req.body || {};

    if (!Array.isArray(records) || records.length === 0) {
      return res
        .status(400)
        .json({ message: 'records must be a non-empty array' });
    }

    // Limit per call so Vercel doesn’t time out
    const MAX_PER_CALL = 200;
    if (records.length > MAX_PER_CALL) {
      return res.status(400).json({
        message: `Too many records in one call. Max ${MAX_PER_CALL}.`,
        received: records.length
      });
    }

    const results = [];
    let successCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const row of records) {
      const rowId = row.id;
      let payload = row.payload;

      // If payload accidentally comes as string, try to parse
      if (payload && typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch (e) {
          results.push({
            rowId,
            status: 'error',
            error: 'Invalid JSON in payload',
            rawPayload: row.payload
          });
          errorCount++;
          continue;
        }
      }

      // Attach deviceId if needed for tracing
      const finalPayload = {
        ...(payload || {}),
        deviceId: deviceId || payload?.deviceId || null
      };

      // 1) Run custom check
      if (!customCheckLocationPayload(finalPayload)) {
        results.push({
          rowId,
          status: 'skipped',
          reason: 'customCheck_failed'
        });
        skippedCount++;
        continue;
      }

      // 2) Call main API for this one record
      try {
        const apiResponse = await sendToUpdateLocations(finalPayload);

        results.push({
          rowId,
          status: 'success',
          apiResponse
        });
        successCount++;
      } catch (err) {
        console.error('Error sending to main API for row', rowId, err.message);

        results.push({
          rowId,
          status: 'error',
          error: err.message
        });
        errorCount++;
      }
    }

    return res.status(200).json({
      status: 'done',
      total: records.length,
      successCount,
      skippedCount,
      errorCount,
      results
    });
  } catch (err) {
    console.error('location-bulk-sync worker error:', err);
    return res.status(500).json({
      message: 'Unexpected error in worker',
      error: err.message
    });
  }
}
