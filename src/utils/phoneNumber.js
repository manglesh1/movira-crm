const { parsePhoneNumberFromString } = require("libphonenumber-js/min");

const ALIASES = new Map([
  ["canada", "CA"], ["ca", "CA"], ["united states", "US"], ["usa", "US"], ["us", "US"],
  ["united kingdom", "GB"], ["uk", "GB"], ["gb", "GB"], ["australia", "AU"], ["au", "AU"],
  ["new zealand", "NZ"], ["nz", "NZ"], ["india", "IN"], ["in", "IN"],
]);

function countryCode(country, fallback = "CA") {
  const value = String(country || "").trim().toLowerCase();
  return ALIASES.get(value) || (/^[a-z]{2}$/.test(value) ? value.toUpperCase() : fallback);
}

function normalizePhoneNumber(value, locationCountry) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = parsePhoneNumberFromString(raw, countryCode(locationCountry));
  return parsed?.isValid() ? parsed.number : null;
}

module.exports = { countryCode, normalizePhoneNumber };
