const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const winston = require('winston');
const DocumentProcessor = require('./services/DocumentProcessor');
const QueueManager = require('./services/QueueManager');
const { validateEnvironment } = require('./utils/environment');
const { createLogger } = require('./utils/logger');

const app = express();
const port = process.env.PORT || 8080;

// Validate environment variables on startup
try {
  validateEnvironment();
} catch (error) {
  console.error('❌ Environment validation failed:', error.message);
  process.exit(1);
}

// Initialize logger
const logger = createLogger();

// Initialize services
let documentProcessor;
let queueManager;

async function initializeServices() {
  try {
    logger.info('🚀 Initializing Floucast Document Processor');
    
    documentProcessor = new DocumentProcessor({ logger });
    await documentProcessor.initialize();
    
    queueManager = new QueueManager({ 
      documentProcessor, 
      logger 
    });
    
    logger.info('✅ Services initialized successfully');
  } catch (error) {
    logger.error('❌ Service initialization failed:', error);
    process.exit(1);
  }
}

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  next();
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: require('../package.json').version
    };

    // Check service health
    if (documentProcessor) {
      health.services = {
        supabase: await documentProcessor.checkHealth(),
        ai: await documentProcessor.checkAIHealth()
      };
    }

    res.json(health);
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Metrics endpoint for monitoring/auto-scaling
app.get('/metrics', async (req, res) => {
  try {
    const metrics = await queueManager.getMetrics();
    res.json(metrics);
  } catch (error) {
    logger.error('Metrics collection failed:', error);
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
});

// Manual processing endpoint (for testing)
app.post('/process', async (req, res) => {
  try {
    const { documentId, vertical, organizationId } = req.body;
    
    if (!documentId || !vertical) {
      return res.status(400).json({
        error: 'Missing required fields: documentId, vertical'
      });
    }
    
    logger.info('Manual processing request received', {
      documentId,
      vertical,
      organizationId
    });
    
    const result = await documentProcessor.processDocument({
      documentId,
      vertical,
      organizationId
    });
    
    res.json({
      success: true,
      result
    });
  } catch (error) {
    logger.error('Manual processing failed:', error);
    res.status(500).json({
      error: 'Processing failed',
      message: error.message
    });
  }
});

// Graceful shutdown handling
async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);
  
  try {
    // Stop accepting new requests
    server.close(() => {
      logger.info('HTTP server closed');
    });
    
    // Stop queue processing
    if (queueManager) {
      await queueManager.stop();
    }
    
    // Close service connections
    if (documentProcessor) {
      await documentProcessor.cleanup();
    }
    
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown:', error);
    process.exit(1);
  }
}

// Error handling
app.use((error, req, res, next) => {
  logger.error('Unhandled request error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
});

// Start server
async function start() {
  try {
    await initializeServices();
    
    const server = app.listen(port, '0.0.0.0', () => {
      logger.info(`🚀 Document Processor listening on port ${port}`);
    });
    
    // Start queue processing
    await queueManager.start();
    
    // Setup graceful shutdown
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    
    return server;
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start if running directly
if (require.main === module) {
  start().catch(error => {
    console.error('Startup failed:', error);
    process.exit(1);
  });
}

module.exports = { app, start };