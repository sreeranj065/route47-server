import { companyRoutes } from "./auth.js";
import { discoverBusinessWebHints, searchBusinessLocations } from "../lib/business-web-search.js";

companyRoutes.get("/route47/companies/:companyId/search/business", async (c) => {
  const query = c.req.query("q")?.trim() ?? "";
  const countryName = c.req.query("country")?.trim();
  const countryCode = c.req.query("countryCode")?.trim();
  const geocode = c.req.query("geocode") !== "0";
  const limit = Math.min(Number(c.req.query("limit") ?? "8") || 8, 12);

  if (query.length < 3) {
    return c.json({ message: "Query must be at least 3 characters.", hints: [], results: [] });
  }

  if (geocode) {
    const results = await searchBusinessLocations(query, { countryName, countryCode, limit });
    return c.json({
      message: `${results.length} business location(s).`,
      query,
      results,
    });
  }

  const hints = await discoverBusinessWebHints(query, { countryName, countryCode, limit });
  return c.json({
    message: `${hints.length} web hint(s).`,
    query,
    hints,
  });
});
