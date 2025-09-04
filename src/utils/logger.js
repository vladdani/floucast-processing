const winston = require('winston');

function createLogger() {
  // Check if running in production (ECS/CloudWatch doesn't support colors)
  const isProduction = process.env.NODE_ENV === 'production';
  
  // Build format array conditionally
  const consoleFormats = [
    winston.format.timestamp(),
    // Only add colorize in non-production environments
    !isProduction && winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      let log = `${timestamp} [${level}] ${message}`;
      if (Object.keys(meta).length > 0) {
        log += ` ${JSON.stringify(meta)}`;
      }
      return log;
    })
  ].filter(Boolean); // Remove false values from colorize condition
  
  // Simple console transport - ECS handles CloudWatch integration automatically
  const transports = [
    new winston.transports.Console({
      format: winston.format.combine(...consoleFormats)
    })
  ];
  
  const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    transports,
    exitOnError: false
  });
  
  // Handle uncaught exceptions and rejections
  const exceptionFormats = [
    !isProduction && winston.format.colorize(),
    winston.format.simple()
  ].filter(Boolean);
  
  logger.exceptions.handle(
    new winston.transports.Console({
      format: winston.format.combine(...exceptionFormats)
    })
  );
  
  logger.rejections.handle(
    new winston.transports.Console({
      format: winston.format.combine(...exceptionFormats)
    })
  );
  
  return logger;
}

module.exports = { createLogger };