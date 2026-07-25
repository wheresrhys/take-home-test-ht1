import express from "express";

import { ingestFormController } from "./controllers/ingest";

const app = express();

app.use(express.json());

app.post("/ingest", ingestFormController);

export default app;
