const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const mailQueue = new Queue("rmo-mail", { connection });
module.exports = { mailQueue, connection };