require("dotenv").config();
const { Worker } = require("bullmq");
const { google } = require("googleapis");
const prisma = require("./db");
const { decrypt } = require("./security");
const { connection } = require("./queue");

function b64url(s) { return Buffer.from(s).toString("base64url"); }
function personalize(html, contact) {
  const values = {
    firstName: contact.firstName || "",
    lastName: contact.lastName || "",
    email: contact.email,
    company: contact.company || ""
  };
  let out = html.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key) => Object.hasOwn(values, key) ? escapeHtml(values[key]) : m);
  return out;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])); }
function addUnsubscribe(html, email, campaignId) {
  const url = `${process.env.APP_URL}/api/unsubscribe?campaignId=${encodeURIComponent(campaignId)}&email=${encodeURIComponent(email)}`;
  const safe = url.replace(/&/g, "&amp;");
  return `${html}<hr><p style="font:12px Arial;color:#777">You are receiving this because you opted in to receive these emails. <a href="${safe}">Unsubscribe</a>.</p>`;
}
const worker = new Worker("rmo-mail", async job => {
  const { campaignId, contactId } = job.data;
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, include: { account: true } });
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!campaign || !contact || !contact.consentedAt || contact.unsubscribedAt) return;
  const blocked = await prisma.suppression.findUnique({ where: { email: contact.email } });
  if (blocked) return;
  const prior = await prisma.delivery.findFirst({ where: { campaignId, contact: contact.email, status: "sent" } });
  if (prior) return;
  const delivery = await prisma.delivery.create({ data: { campaignId, contact: contact.email, status: "sending" } });
  try {
    if (campaign.account.provider !== "gmail") throw new Error("Unsupported sending provider");
    const oauth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
    oauth.setCredentials({ refresh_token: decrypt(campaign.account.encryptedRefresh) });
    const gmail = google.gmail({ version: "v1", auth: oauth });
    const html = addUnsubscribe(personalize(campaign.html, contact), contact.email, campaign.id);
    const fromName = campaign.account.displayName.replace(/[\r\n"]/g, "");
    const raw = [
      `From: "${fromName}" <${campaign.account.email}>`,
      `To: ${contact.email}`,
      `Subject: ${campaign.subject.replace(/[\r\n]/g, " ")}`,
      "MIME-Version: 1.0",
      'Content-Type: text/html; charset="UTF-8"',
      "List-Unsubscribe: <" + `${process.env.APP_URL}/api/unsubscribe?campaignId=${encodeURIComponent(campaign.id)}&email=${encodeURIComponent(contact.email)}` + ">",
      "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
      "",
      html
    ].join("\r\n");
    const sent = await gmail.users.messages.send({ userId: "me", requestBody: { raw: b64url(raw) } });
    await prisma.delivery.update({ where: { id: delivery.id }, data: { status: "sent", providerId: sent.data.id, sentAt: new Date() } });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { sent: { increment: 1 }, status: "sending" } });
  } catch (e) {
    await prisma.delivery.update({ where: { id: delivery.id }, data: { status: "failed", error: String(e.message).slice(0, 500) } });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { failed: { increment: 1 } } });
    throw e;
  } finally {
    const counts = await prisma.delivery.groupBy({ by: ["status"], where: { campaignId }, _count: { _all: true } });
    const done = counts.reduce((n, x) => n + x._count._all, 0);
    if (done >= campaign.total) await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "completed" } });
  }
}, { connection, concurrency: 2, limiter: { max: 20, duration: 60_000 } });
worker.on("failed", (job, err) => console.error("Mail job failed", job?.id, err.message));
console.log("RMO Sender mail worker running (20 messages/minute/account queue; adjust only within provider rules).");