/**
 * Command-policy examples shared by the policy suite (pure check) and the
 * executor suite (zero bytes written). Simulated test matrix rows 26-27.
 */

/** Row 26: every denied example, refused with a recorded reason. */
export const DENIED_EXAMPLES = ["04", "08", "1003", "2EF19000", "ATMA", "ATMR", "ATSH7E0", "ATCRA7E8", "ATPP0CSV23", "AT@3", "ATBRD23", "ATST32", "ATSP6", "ATD", "05", "0601", "19", "22F190", "27", "3E00", "85", "3101"];

/** Row 27 and more: case, whitespace, separator, injection and concatenation variants. */
export const MALFORMED_EXAMPLES = [
  "",
  "at ma",
  "atma",
  "atz",
  "Atz",
  " ATZ",
  "ATZ ",
  "ATZ\r",
  "ATZ\n",
  "ATZ\rATMA",
  "03\r04",
  "03\n04",
  "03\r\n",
  "03\r",
  "\r03",
  "03 04",
  "03;04",
  "03,04",
  "01 0C",
  "010c",
  "0100\r04\r",
  "010C\u0000",
  "\u000003",
  "\t03",
  "0x03",
  "０３", // full-width digits
  "03​", // zero-width space
  "AT Z",
  "AT@1 ",
];

/** Well-formed text that is still not on the allowlist (concatenated or out-of-scope). */
export const NOT_ALLOWED_EXAMPLES = ["0304", "0303", "030A", "0A0A", "0300", "010C0D", "020001", "02000", "09020", "0901", "0904", "ATSP", "ATH2", "ATE1", "ATL1", "ATZZ", "AT", "OK", "Z"];
