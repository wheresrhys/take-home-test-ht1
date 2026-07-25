import express, { Request, Response } from "express";

import { retryFailedForms } from "./controllers/retry";

const app = express();

app.use(express.json());

app.post("/ingest", (req: Request, res: Response) => {
	res.json({ message: "Ingesting form data" });
});

app.post("/retry", retryFailedForms);

export default app;
