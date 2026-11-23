const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const KEY = () => {
  const key = process.env.ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error("ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters");
  return Buffer.from(key, "hex");
};
function encrypt(value) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", KEY(), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), data.toString("hex")].join(".");
}
function decrypt(value) {
  const [iv, tag, data] = value.split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY(), Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(data, "hex")), decipher.final()]).toString("utf8");
}
function sign(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: "12h", issuer: "rmo-sender" });
}
function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    req.user = jwt.verify(token, process.env.JWT_SECRET, { issuer: "rmo-sender" });
    next();
  } catch { res.status(401).json({ error: "Sign in required" }); }
}
module.exports = { encrypt, decrypt, sign, auth };