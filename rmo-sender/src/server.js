require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { google } = require("googleapis");
const OpenAI = require("openai");
const prisma = require("./db");
const { auth, sign, encrypt } = require("./security");
const { mailQueue } = require("./queue");

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.APP_URL, credentials: true }));
app.use(compression());
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 120 }));
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

app.get("/api/health", (_, res) => res.json({ ok: true, app: "RMO Sender" }));
app.post("/api/auth/register", async (req, res) => {
  const parsed = z.object({ email: z.string().email().max(254), password: z.string().min(12).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Use a valid email and a password of at least 12 characters." });
  try {
    const user = await prisma.user.create({ data: { email: parsed.data.email.toLowerCase(), passwordHash: await bcrypt.hash(parsed.data.password, 12) } });
    res.json({ token: sign(user), user: { id: user.id, email: user.email } });
  } catch { res.status(409).json({ error: "An account with that email already exists." }); }
});
app.post("/api/auth/login", async (req, res) => {
  const parsed = z.object({ email: z.string().email(), password: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid credentials." });
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) return res.status(401).json({ error: "Invalid email or password." });
  res.json({ token: sign(user), user: { id: user.id, email: user.email } });
});
app.get("/api/me", auth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.sub }, select: { id: true, email: true, role: true, createdAt: true } });
  res.json(user);
});

// Google OAuth: requests send-only access and offline refresh token. Only the connected mailbox is used.
function googleClient() {
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
}
app.get("/api/connect/google", auth, (req, res) => {
  const state = require("jsonwebtoken").sign({ uid: req.user.sub, nonce: require("node:crypto").randomBytes(18).toString("hex") }, process.env.JWT_SECRET, { expiresIn: "10m", issuer: "rmo-google-oauth" });
  res.json({ url: googleClient().generateAuthUrl({ access_type: "offline", prompt: "consent", scope: ["https://www.googleapis.com/auth/gmail.send", "openid", "email"], state }) });
});
app.get("/api/connect/google/callback", async (req, res) => {
  try {
    const state = require("jsonwebtoken").verify(String(req.query.state || ""), process.env.JWT_SECRET, { issuer: "rmo-google-oauth" });
    const { tokens } = await googleClient().getToken(req.query.code);
    if (!tokens.refresh_token) throw new Error("Google did not return a refresh token; reconnect and grant consent.");
    const oauth = googleClient(); oauth.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth: oauth });
    const profile = await oauth2.userinfo.get();
    const email = profile.data.email;
    const user = await prisma.user.findUnique({ where: { id: state.uid } });
    if (!user || !email) throw new Error("Could not validate connected user.");
    await prisma.sendingAccount.upsert({
      where: { userId_email: { userId: user.id, email } },
      update: { encryptedRefresh: encrypt(tokens.refresh_token), status: "connected" },
      create: { userId: user.id, provider: "gmail", email, displayName: profile.data.name || email, encryptedRefresh: encrypt(tokens.refresh_token) }
    });
    res.redirect("/?connected=google");
  } catch (e) { res.status(400).send("Google connection failed. Return to RMO Sender and try again."); }
});
app.get("/api/accounts", auth, async (req, res) => {
  const rows = await prisma.sendingAccount.findMany({ where: { userId: req.user.sub }, select: { id: true, provider: true, email: true, displayName: true, status: true, createdAt: true } });
  res.json(rows);
});
app.patch("/api/accounts/:id/name", auth, async (req, res) => {
  const name = z.string().trim().min(1).max(80).safeParse(req.body.displayName);
  if (!name.success) return res.status(400).json({ error: "Sender display name must be 1–80 characters." });
  const account = await prisma.sendingAccount.updateMany({ where: { id: req.params.id, userId: req.user.sub }, data: { displayName: name.data } });
  if (!account.count) return res.status(404).json({ error: "Account not found." });
  res.json({ ok: true });
});

// Contacts must be imported with documented permission. Do not accept purchased/scraped lists.
app.post("/api/contacts/import", auth, async (req, res) => {
  const rows = z.array(z.object({
    email: z.string().email().max(254), firstName: z.string().optional(), lastName: z.string().optional(),
    company: z.string().optional(), consentedAt: z.string().datetime(), consentSource: z.string().min(3).max(200)
  })).min(1).max(6000).safeParse(req.body.contacts);
  if (!rows.success) return res.status(400).json({ error: "Each contact needs a valid email, consent timestamp, and consent source." });
  let imported = 0;
  for (const c of rows.data) {
    await prisma.contact.upsert({
      where: { userId_email: { userId: req.user.sub, email: c.email.toLowerCase() } },
      update: { firstName: c.firstName, lastName: c.lastName, company: c.company, consentedAt: new Date(c.consentedAt), consentSource: c.consentSource },
      create: { userId: req.user.sub, ...c, email: c.email.toLowerCase(), consentedAt: new Date(c.consentedAt) }
    });
    imported++;
  }
  res.json({ imported });
});
app.get("/api/contacts", auth, async (req, res) => {
  const contacts = await prisma.contact.findMany({ where: { userId: req.user.sub }, orderBy: { createdAt: "desc" }, take: 500 });
  res.json(contacts);
});
async function processUnsubscribe(email, campaignId, res) {
  const parsed = z.object({ email: z.string().email(), campaignId: z.string() }).safeParse({ email, campaignId });
  if (!parsed.success) return res.status(400).send("Invalid request");
  const campaign = await prisma.campaign.findUnique({ where: { id: parsed.data.campaignId } });
  if (!campaign) return res.status(404).send("Campaign not found");
  await prisma.contact.updateMany({ where: { userId: campaign.userId, email: parsed.data.email.toLowerCase() }, data: { unsubscribedAt: new Date() } });
  await prisma.suppression.upsert({ where: { email: parsed.data.email.toLowerCase() }, update: { reason: "unsubscribe" }, create: { email: parsed.data.email.toLowerCase(), reason: "unsubscribe" } });
  return res.send("You have been unsubscribed.");
}
app.get("/api/unsubscribe", (req, res) => processUnsubscribe(req.query.email, req.query.campaignId, res));
app.post("/api/unsubscribe", (req, res) => processUnsubscribe(req.body.email, req.body.campaignId, res));

app.post("/api/ai/assist", auth, async (req, res) => {
  if (!openai) return res.status(503).json({ error: "AI is not configured. Add OPENAI_API_KEY to the server environment." });
  const input = z.object({ task: z.enum(["write", "improve", "subject", "scan"]), prompt: z.string().min(3).max(12000), html: z.string().max(50000).optional() }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: "Invalid AI request." });
  const system = "You are RMO Sender's compliant email campaign assistant. Help create truthful, relevant, permission-based marketing or operational email content. Never help impersonate a sender, evade spam filters, conceal identity, or bypass consent/unsubscribe rules. For scan tasks, identify placeholders such as {{firstName}}, {{company}}, {{email}} and explain their exact data mapping. Return concise useful output.";
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    messages: [{ role: "system", content: system }, { role: "user", content: `${input.data.task.toUpperCase()} TASK\n${input.data.prompt}\n\nHTML:\n${input.data.html || "(none)"}` }]
  });
  res.json({ result: completion.choices[0]?.message?.content || "" });
});

app.post("/api/campaigns", auth, async (req, res) => {
  const p = z.object({ name: z.string().min(2).max(120), subject: z.string().min(2).max(200), html: z.string().min(20).max(50000), accountId: z.string() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Check campaign name, subject, HTML and sending account." });
  const account = await prisma.sendingAccount.findFirst({ where: { id: p.data.accountId, userId: req.user.sub, status: "connected" } });
  if (!account) return res.status(400).json({ error: "Connect a verified sending account first." });
  const campaign = await prisma.campaign.create({ data: { ...p.data, userId: req.user.sub } });
  res.json(campaign);
});
app.get("/api/campaigns", auth, async (req, res) => {
  const campaigns = await prisma.campaign.findMany({ where: { userId: req.user.sub }, orderBy: { createdAt: "desc" }, take: 100 });
  res.json(campaigns);
});
app.post("/api/campaigns/:id/duplicate", auth, async (req, res) => {
  const original = await prisma.campaign.findFirst({ where: { id: req.params.id, userId: req.user.sub } });
  if (!original) return res.status(404).json({ error: "Campaign not found." });
  const copy = await prisma.campaign.create({ data: { userId: req.user.sub, accountId: original.accountId, name: `${original.name} (copy)`.slice(0, 120), subject: original.subject, html: original.html, status: "draft" } });
  res.json(copy);
});
app.post("/api/campaigns/:id/send", auth, async (req, res) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, userId: req.user.sub }, include: { account: true } });
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  if (campaign.status === "queued" || campaign.status === "sending" || campaign.status === "completed") return res.status(409).json({ error: "This campaign has already been queued or sent." });
  const contacts = await prisma.contact.findMany({ where: { userId: req.user.sub, consentedAt: { not: null }, unsubscribedAt: null }, take: 6000 });
  const suppressed = await prisma.suppression.findMany({ where: { email: { in: contacts.map(c => c.email) } }, select: { email: true } });
  const blocked = new Set(suppressed.map(x => x.email));
  const eligible = contacts.filter(c => !blocked.has(c.email));
  if (!eligible.length) return res.status(400).json({ error: "No eligible opted-in contacts are available." });
  if (eligible.length > 6000) return res.status(400).json({ error: "Campaign exceeds the 6,000-recipient limit." });
  await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "queued", total: eligible.length } });
  for (const contact of eligible) {
    await mailQueue.add("send-one", { campaignId: campaign.id, contactId: contact.id }, { attempts: 3, backoff: { type: "exponential", delay: 10000 }, removeOnComplete: 1000, removeOnFail: 2000 });
  }
  res.json({ queued: eligible.length, campaignId: campaign.id });
});
app.get("/api/campaigns/:id/deliveries", auth, async (req, res) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, userId: req.user.sub } });
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  const deliveries = await prisma.delivery.findMany({ where: { campaignId: campaign.id }, orderBy: { createdAt: "desc" }, take: 500 });
  res.json(deliveries);
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`RMO Sender listening on ${port}`));