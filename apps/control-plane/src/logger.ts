import winston from "winston";

// Ported from the TaskFlow backend (winston), retargeted to the control-plane.
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  defaultMeta: { service: "throughline-control-plane" },
  transports: [new winston.transports.Console({ format: winston.format.simple() })],
});

export default logger;
