const winston = require('winston');
const AWS = require('aws-sdk');

function createLogger() {
  const transports = [];
  
  // Console transport for all environments
  transports.push(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        let log = `${timestamp} [${level}] ${message}`;
        if (Object.keys(meta).length > 0) {
          log += ` ${JSON.stringify(meta)}`;
        }
        return log;
      })
    )
  }));
  
  // CloudWatch transport for production
  if (process.env.NODE_ENV === 'production' && process.env.AWS_REGION) {
    try {
      const cloudWatchLogs = new AWS.CloudWatchLogs({
        region: process.env.AWS_REGION
      });
      
      transports.push(new winston.transports.Stream({
        stream: {
          write: (message) => {
            // Simple CloudWatch logging - in production you'd want proper log groups
            console.log(message.trim());
          }
        },
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        )
      }));
    } catch (error) {
      console.warn('Failed to initialize CloudWatch logging:', error.message);
    }
  }
  
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
  logger.exceptions.handle(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  );
  
  logger.rejections.handle(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  );
  
  return logger;
}

module.exports = { createLogger };