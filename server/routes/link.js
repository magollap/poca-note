import { asyncHandler } from "../util.js";
import { lookupLinkTitle } from "../services/linkTitle.js";

export function mountLinkRoutes(app, { db, config, linkLimiter }) {
  app.get(
    "/api/link-title",
    linkLimiter,
    asyncHandler(async (req, res) => {
      const url = String(req.query.url || "");
      const result = await lookupLinkTitle(db, url, config.linkFetch);
      res.json(result);
    })
  );
}
