import express from "express";

import { ingestFormController } from "./controllers/ingest";

import { retryFailedForms } from "./controllers/retry";

const app = express();

app.use(express.json());

app.post("/ingest", ingestFormController);

app.post("/retry", retryFailedForms);

export default app;
