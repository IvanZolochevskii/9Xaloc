import type { Config } from "@netlify/functions";

/**
 * Reads the property's Google rating and reviews through the Places API (New).
 *
 * Configuration (Netlify environment variables, all optional except the API key):
 *   GOOGLE_PLACES_API_KEY - Places API (New) key. Without it the rating and review cards are
 *                           unavailable, but the "Review us on Google" link still works.
 *   GOOGLE_MAPS_URL       - overrides the built-in share link for the listing
 *   GOOGLE_PLACE_ID       - skips place resolution and saves an API call
 *   GOOGLE_PLACE_QUERY    - "name, city" fallback used when the URL cannot be resolved
 */

// The property's public Google Maps listing. Not a secret, so it ships as the default
// and only needs an environment variable if the listing ever moves.
const DEFAULT_MAPS_URL = "https://maps.app.goo.gl/5EmacKGhFQ8wn3reA";
const DEFAULT_PLACE_QUERY = "Seaview Apartment to Rent, Cala de Finestrat, Alicante, Spain";

const PLACES_BASE = "https://places.googleapis.com/v1";
const DETAIL_FIELDS = "id,displayName,rating,userRatingCount,googleMapsUri,googleMapsLinks,reviews";

type PlaceReview = {
  name?: string;
  rating?: number;
  text?: { text?: string };
  originalText?: { text?: string };
  relativePublishTimeDescription?: string;
  publishTime?: string;
  authorAttribution?: { displayName?: string; uri?: string; photoUri?: string };
};

function json(payload: unknown, status = 200) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (status === 200) {
    // Serve from the CDN for six hours so the Places quota is barely touched.
    headers["Cache-Control"] = "public, max-age=300";
    headers["Netlify-CDN-Cache-Control"] = "public, max-age=21600, stale-while-revalidate=86400";
  } else {
    headers["Cache-Control"] = "no-store";
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

function writeReviewUrl(placeId: string | null, mapsUrl: string | null): string | null {
  if (placeId) return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;
  return mapsUrl;
}

type ResolvedUrl = {
  placeId: string | null;
  query: string | null;
  location: { latitude: number; longitude: number } | null;
};

/** Pull a place id straight out of a Maps URL, following short links when needed. */
async function placeIdFromUrl(rawUrl: string): Promise<ResolvedUrl> {
  let finalUrl = rawUrl;

  try {
    const response = await fetch(rawUrl, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } });
    if (response.url) finalUrl = response.url;
  } catch (error) {
    console.warn("Could not follow Google Maps link:", (error as Error).message);
  }

  // Maps URLs carry the viewport centre as /@lat,lng,zoom - useful for biasing a name search.
  const coords = finalUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  const location = coords
    ? { latitude: Number(coords[1]), longitude: Number(coords[2]) }
    : null;

  let parsed: URL;
  try {
    parsed = new URL(finalUrl);
  } catch {
    return { placeId: null, query: null, location };
  }

  const direct =
    parsed.searchParams.get("place_id") ||
    parsed.searchParams.get("placeid") ||
    parsed.searchParams.get("query_place_id");
  if (direct) return { placeId: direct, query: null, location };

  const embedded = finalUrl.match(/ChI[A-Za-z0-9_-]{10,}/);
  if (embedded) return { placeId: embedded[0], query: null, location };

  // No id in the URL: fall back to searching for the place name it points at.
  const named = decodeURIComponent(parsed.pathname).match(/\/place\/([^/]+)/);
  if (named) return { placeId: null, query: named[1].replace(/\+/g, " "), location };

  const searched = parsed.searchParams.get("q");
  return { placeId: null, query: searched, location };
}

async function resolvePlaceId(
  apiKey: string,
  query: string,
  location: { latitude: number; longitude: number } | null
): Promise<string | null> {
  const body: Record<string, unknown> = { textQuery: query, maxResultCount: 1 };

  // A holiday-let name is rarely unique, so bias the search to the map pin when we have it.
  if (location) {
    body.locationBias = { circle: { center: location, radius: 500 } };
  }

  const response = await fetch(`${PLACES_BASE}/places:searchText`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.displayName",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    console.error("Places text search failed:", response.status, await response.text());
    return null;
  }

  const data = (await response.json()) as { places?: Array<{ id?: string }> };
  return data.places?.[0]?.id || null;
}

async function fetchPlace(apiKey: string, placeId: string, language: string) {
  const url = `${PLACES_BASE}/places/${encodeURIComponent(placeId)}?languageCode=${encodeURIComponent(language)}`;
  const response = await fetch(url, {
    headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": DETAIL_FIELDS },
  });

  if (!response.ok) {
    throw new Error(`Places details failed: ${response.status} ${await response.text()}`);
  }

  return response.json() as Promise<{
    id?: string;
    displayName?: { text?: string };
    rating?: number;
    userRatingCount?: number;
    googleMapsUri?: string;
    googleMapsLinks?: { writeAReviewUri?: string; reviewsUri?: string };
    reviews?: PlaceReview[];
  }>;
}

export default async (req: Request) => {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const mapsUrl = process.env.GOOGLE_MAPS_URL || DEFAULT_MAPS_URL;
  const language = new URL(req.url).searchParams.get("lang") || "en";
  let placeId = process.env.GOOGLE_PLACE_ID || null;

  if (!apiKey) {
    // Links still work; only the review list needs a key.
    return json({
      configured: false,
      reason: "GOOGLE_PLACES_API_KEY is not set.",
      mapsUrl,
      writeReviewUrl: writeReviewUrl(placeId, mapsUrl),
      rating: null,
      total: 0,
      reviews: [],
    });
  }

  try {
    if (!placeId) {
      let query = process.env.GOOGLE_PLACE_QUERY || null;
      const fallbackQuery = DEFAULT_PLACE_QUERY;
      let location: { latitude: number; longitude: number } | null = null;

      if (mapsUrl) {
        const fromUrl = await placeIdFromUrl(mapsUrl);
        placeId = fromUrl.placeId;
        query = query || fromUrl.query;
        location = fromUrl.location;
      }

      if (!placeId) {
        placeId = await resolvePlaceId(apiKey, query || fallbackQuery, location);
      }
    }

    if (!placeId) {
      return json({
        configured: false,
        reason: "Could not identify the Google place. Set GOOGLE_PLACE_ID to resolve it directly.",
        mapsUrl,
        writeReviewUrl: writeReviewUrl(null, mapsUrl),
        rating: null,
        total: 0,
        reviews: [],
      });
    }

    const place = await fetchPlace(apiKey, placeId, language);

    const reviews = (place.reviews || []).map((review) => ({
      author: review.authorAttribution?.displayName || "Google guest",
      authorUrl: review.authorAttribution?.uri || null,
      photo: review.authorAttribution?.photoUri || null,
      rating: review.rating ?? null,
      text: review.text?.text || review.originalText?.text || "",
      relativeTime: review.relativePublishTimeDescription || null,
      publishTime: review.publishTime || null,
    }));

    return json({
      configured: true,
      placeId: place.id || placeId,
      name: place.displayName?.text || null,
      rating: place.rating ?? null,
      total: place.userRatingCount ?? 0,
      mapsUrl: place.googleMapsUri || mapsUrl,
      reviewsUrl: place.googleMapsLinks?.reviewsUri || place.googleMapsUri || mapsUrl,
      writeReviewUrl:
        place.googleMapsLinks?.writeAReviewUri || writeReviewUrl(place.id || placeId, mapsUrl),
      reviews,
    });
  } catch (error) {
    console.error("google-reviews function failed:", error);
    return json(
      {
        configured: false,
        reason: "Google reviews could not be loaded right now.",
        mapsUrl,
        writeReviewUrl: writeReviewUrl(placeId, mapsUrl),
        rating: null,
        total: 0,
        reviews: [],
      },
      200
    );
  }
};

export const config: Config = {
  path: "/api/google-reviews",
};
