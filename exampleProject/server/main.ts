import { connect, migrate } from './store.js';
import { createApp } from './app.js';
const db = connect();
await migrate(db);
const server = createApp(db, process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:8080').listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('Example 服务启动，端口 ' + (process.env.PORT || 8080)));
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { server.close(() => { void db.end(); }); });

