// Bonto's free tier sleeps after 30 minutes of inactivity. This runs every
// 10 minutes and just hits the server's homepage to keep it awake, so a
// real call never lands on a sleeping server. Only needed while on the
// free tier - safe to delete once/if upgraded to an always-on plan.

exports.handler = async function () {
  const url = process.env.REALTIME_SERVER_URL;
  if (!url) {
    console.log("REALTIME_SERVER_URL not set - nothing to ping");
    return { statusCode: 200, body: "not configured" };
  }

  try {
    const res = await fetch(`https://${url}/`);
    console.log("Pinged realtime server to keep it awake", { status: res.status });
  } catch (err) {
    console.error("Failed to ping realtime server", err);
  }

  return { statusCode: 200, body: "pinged" };
};
