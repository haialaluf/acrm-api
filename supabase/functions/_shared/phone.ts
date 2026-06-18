/**
 * Phone number utilities.
 *
 * Contact addresses are stored as E.164 digits (no leading "+"), e.g.
 * "972541234567". We use libphonenumber-js to resolve the contact's country,
 * then map it to a representative IANA timezone — good enough to render a
 * sensible "local now" in the LLM context without asking the user for their
 * actual timezone.
 */
import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * ISO 3166-1 alpha-2 country -> representative IANA timezone.
 *
 * For countries spanning multiple timezones (US, Russia, Brazil, Australia, …)
 * a representative zone is used (capital / most populous). libphonenumber-js
 * resolves the country precisely (including disambiguating shared calling codes
 * like +1 US/Canada and +7 Russia/Kazakhstan), but the within-country zone
 * still can't be derived from the number, so it remains an approximation.
 */
const COUNTRY_TIMEZONES: Record<string, string> = {
  AD: "Europe/Andorra",
  AE: "Asia/Dubai",
  AF: "Asia/Kabul",
  AL: "Europe/Tirane",
  AM: "Asia/Yerevan",
  AR: "America/Argentina/Buenos_Aires",
  AT: "Europe/Vienna",
  AU: "Australia/Sydney",
  AZ: "Asia/Baku",
  BA: "Europe/Sarajevo",
  BD: "Asia/Dhaka",
  BE: "Europe/Brussels",
  BG: "Europe/Sofia",
  BH: "Asia/Bahrain",
  BN: "Asia/Brunei",
  BO: "America/La_Paz",
  BR: "America/Sao_Paulo",
  BY: "Europe/Minsk",
  BZ: "America/Belize",
  CA: "America/Toronto",
  CH: "Europe/Zurich",
  CL: "America/Santiago",
  CM: "Africa/Douala",
  CN: "Asia/Shanghai",
  CO: "America/Bogota",
  CR: "America/Costa_Rica",
  CU: "America/Havana",
  CY: "Asia/Nicosia",
  CZ: "Europe/Prague",
  DE: "Europe/Berlin",
  DK: "Europe/Copenhagen",
  DO: "America/Santo_Domingo",
  DZ: "Africa/Algiers",
  EC: "America/Guayaquil",
  EE: "Europe/Tallinn",
  EG: "Africa/Cairo",
  ES: "Europe/Madrid",
  ET: "Africa/Addis_Ababa",
  FI: "Europe/Helsinki",
  FJ: "Pacific/Fiji",
  FK: "Atlantic/Stanley",
  FR: "Europe/Paris",
  GB: "Europe/London",
  GE: "Asia/Tbilisi",
  GG: "Europe/Guernsey",
  GH: "Africa/Accra",
  GI: "Europe/Gibraltar",
  GM: "Africa/Banjul",
  GR: "Europe/Athens",
  GT: "America/Guatemala",
  HK: "Asia/Hong_Kong",
  HN: "America/Tegucigalpa",
  HR: "Europe/Zagreb",
  HT: "America/Port-au-Prince",
  HU: "Europe/Budapest",
  ID: "Asia/Jakarta",
  IE: "Europe/Dublin",
  IL: "Asia/Jerusalem",
  IM: "Europe/Isle_of_Man",
  IN: "Asia/Kolkata",
  IQ: "Asia/Baghdad",
  IR: "Asia/Tehran",
  IS: "Atlantic/Reykjavik",
  IT: "Europe/Rome",
  JE: "Europe/Jersey",
  JO: "Asia/Amman",
  JP: "Asia/Tokyo",
  KE: "Africa/Nairobi",
  KG: "Asia/Bishkek",
  KH: "Asia/Phnom_Penh",
  KP: "Asia/Pyongyang",
  KR: "Asia/Seoul",
  KW: "Asia/Kuwait",
  KZ: "Asia/Almaty",
  LA: "Asia/Vientiane",
  LB: "Asia/Beirut",
  LI: "Europe/Vaduz",
  LK: "Asia/Colombo",
  LT: "Europe/Vilnius",
  LU: "Europe/Luxembourg",
  LV: "Europe/Riga",
  LY: "Africa/Tripoli",
  MA: "Africa/Casablanca",
  MC: "Europe/Monaco",
  MD: "Europe/Chisinau",
  ME: "Europe/Podgorica",
  MK: "Europe/Skopje",
  MM: "Asia/Yangon",
  MN: "Asia/Ulaanbaatar",
  MO: "Asia/Macau",
  MT: "Europe/Malta",
  MV: "Indian/Maldives",
  MX: "America/Mexico_City",
  MY: "Asia/Kuala_Lumpur",
  NG: "Africa/Lagos",
  NI: "America/Managua",
  NL: "Europe/Amsterdam",
  NO: "Europe/Oslo",
  NP: "Asia/Kathmandu",
  NZ: "Pacific/Auckland",
  OM: "Asia/Muscat",
  PA: "America/Panama",
  PE: "America/Lima",
  PG: "Pacific/Port_Moresby",
  PH: "Asia/Manila",
  PK: "Asia/Karachi",
  PL: "Europe/Warsaw",
  PS: "Asia/Hebron",
  PT: "Europe/Lisbon",
  PY: "America/Asuncion",
  QA: "Asia/Qatar",
  RO: "Europe/Bucharest",
  RS: "Europe/Belgrade",
  RU: "Europe/Moscow",
  RW: "Africa/Kigali",
  SA: "Asia/Riyadh",
  SD: "Africa/Khartoum",
  SE: "Europe/Stockholm",
  SG: "Asia/Singapore",
  SI: "Europe/Ljubljana",
  SK: "Europe/Bratislava",
  SM: "Europe/San_Marino",
  SN: "Africa/Dakar",
  SS: "Africa/Juba",
  SY: "Asia/Damascus",
  TH: "Asia/Bangkok",
  TJ: "Asia/Dushanbe",
  TL: "Asia/Dili",
  TM: "Asia/Ashgabat",
  TN: "Africa/Tunis",
  TR: "Europe/Istanbul",
  TW: "Asia/Taipei",
  TZ: "Africa/Dar_es_Salaam",
  UA: "Europe/Kyiv",
  UG: "Africa/Kampala",
  US: "America/New_York",
  UY: "America/Montevideo",
  UZ: "Asia/Tashkent",
  VE: "America/Caracas",
  VN: "Asia/Ho_Chi_Minh",
  YE: "Asia/Aden",
  ZA: "Africa/Johannesburg",
  ZM: "Africa/Lusaka",
  ZW: "Africa/Harare",
};

/**
 * Best-effort IANA timezone for a phone number. Resolves the country via
 * libphonenumber-js, then maps it to a representative zone. Returns `undefined`
 * when the number is empty/unparsable or its country has no mapping.
 */
export function getTimezoneFromPhone(
  phone?: string | null,
): string | undefined {
  if (!phone) return undefined;

  // Contact addresses are stored without the leading "+"; add it so
  // libphonenumber-js parses them as international numbers.
  const e164 = phone.startsWith("+") ? phone : "+" + phone;
  const country = parsePhoneNumberFromString(e164)?.country;

  return country ? COUNTRY_TIMEZONES[country] : undefined;
}
