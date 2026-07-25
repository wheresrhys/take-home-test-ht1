import { NextFunction, Request, RequestHandler, Response } from "express";

// Express 4 does not forward a rejected promise from an async route handler to the
// error-handling middleware automatically — an unhandled rejection would otherwise crash the
// process or hang the request. Wrapping a handler in asyncHandler catches any rejection and
// forwards it via next(err), so route handlers can stay plain async functions instead of each
// scattering its own try/catch around calls into the ingest/retry libs.
export function asyncHandler(
	handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
	return (req: Request, res: Response, next: NextFunction) => {
		handler(req, res, next).catch(next);
	};
}
