import { buildApp, prisma } from './app.js';

const app = buildApp();

const start = async () => {
  await app.listen({ port: Number(process.env.PORT || 4000), host: '0.0.0.0' });
  app.log.info('Connectly API listening');
};

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  await app.close();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  await app.close();
  process.exit(0);
});

start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
