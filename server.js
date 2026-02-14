const app = require('./app');
const { logError, logInfo } = require('./utils/logger');

const port = Number(process.env.PORT) || 4000;
const host = process.env.HOST || '0.0.0.0';

process.on('unhandledRejection', (reason) => {
  logError('ERROR_QUEUE', reason instanceof Error ? reason : new Error(String(reason)), {
    stage: 'unhandledRejection',
  });
});

process.on('uncaughtException', (error) => {
  logError('ERROR_QUEUE', error, {
    stage: 'uncaughtException',
  });
});

app.listen(port, host, () => {
  logInfo('SERVER_READY', { url: `http://${host}:${port}` });
});
