import express from "express";

import { ingestFormController } from "./controllers/ingest";
import { asyncHandler } from "./lib/asyncHandler";
import { errorHandler } from "./lib/errorHandler";

import { retryFailedForms } from "./controllers/retry";

const app = express();

app.use(express.json());

app.post("/ingest", asyncHandler(ingestFormController));

app.use(errorHandler);

app.post("/retry", retryFailedForms);

export default app;
