// api/bulk-sync.js  (for Vercel)  OR  pages/api/bulk-sync.js (for Next.js)

const MAIN_API_BASE_URL = process.env.MAIN_API_BASE_URL; // e.g. https://your-main-api.com
const MAIN_API_KEY = process.env.MAIN_API_KEY;           // if you use auth

// ✅ Your custom rule/check per record
function customCheck(record) {
  // --------- EXAMPLES (edit these to your logic) ----------
  // Skip if required field is missing
  if (!record.userId) return false;

  // Skip if value is 0 or negative
  if (record.total !== undefined && record.total <= 0) return false;

  // Add any other business rules here...
  // e.g. if (record.status === 'draft') return false;

  return true;
}

// ✅ Function that sends one record to your main API
async function sendToMainApi(record) {
  // Change this path to your actual endpoint
  const url = `${MAIN_API_BASE_URL}/api/v1/your-endpoint`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(MAIN_API_KEY ? { 'Authorization': `Bearer ${MAIN_API_KEY}` } : {})
    },
    body: JSON.stringify(record)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Main API error ${res.status}: ${text || res.statusText}`);
  }

  const json = await res.json().catch(() => ({}));
  return json;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { deviceId, records } = req.body || {};

    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ message: 'records must be a non-empty array' });
    }

    if (!MAIN_API_BASE_URL) {
      return res.status(500).json({ message: 'MAIN_API_BASE_URL is not configured on worker' });
    }

    // Optional: limit batch size per request so Vercel doesn’t timeout
    const MAX_PER_CALL = 100;
    if (records.length > MAX_PER_CALL) {
      return res.status(400).json({
        message: `Too many records at once. Max ${MAX_PER_CALL}`,
        received: records.length
      });
    }

    const results = [];
    let successCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const record of records) {
      const payload = {
        deviceId: deviceId || null,
        ...record
      };

      // 1) Run your custom business check
      if (!customCheck(payload)) {
        results.push({
          status: 'skipped',
          reason: 'customCheck_failed',
          record
        });
        skippedCount++;
        continue;
      }

      // 2) Send to main API one-by-one
      try {
        const mainResponse = await sendToMainApi(payload);
        results.push({
          status: 'success',
          record,
          mainResponse
        });
        successCount++;
      } catch (err) {
        console.error('Error sending to main API:', err.message);
        results.push({
          status: 'error',
          error: err.message,
          record
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
    console.error('bulk-sync worker error:', err);
    return res.status(500).json({
      message: 'Unexpected error in worker',
      error: err.message
    });
  }
}
