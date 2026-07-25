import express from "express";

import { ingestFormController } from "./controllers/ingest";
import { asyncHandler } from "./lib/asyncHandler";

const app = express();

app.use(express.json());

app.post("/ingest", asyncHandler(ingestFormController));

export default app;
