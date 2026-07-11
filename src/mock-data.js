// Mock data shaped exactly like the real Form Responses columns. Used as
// fallback when no backend is reachable and for automated tests.
//
// Includes a few DELIBERATELY corrupted rows (A016-A018) at the bottom to
// exercise the validation layer, the same way a manually-edited sheet
// eventually will. They should show up as "data issues," not crash anything.

const NEIGHBORHOOD_COORDS = {
  "Kallio": [60.1841, 24.9502],
  "Töölö": [60.1756, 24.9145],
  "Espoo keskus": [60.2052, 24.6522],
  "Kamppi": [60.1687, 24.9316],
  "Kruununhaka": [60.1710, 24.9580],
  "Punavuori": [60.1620, 24.9350],
};

function jitter(coord) {
  return [coord[0] + (Math.random() - 0.5) * 0.01, coord[1] + (Math.random() - 0.5) * 0.02];
}

const RAW_APPLICANTS = [
  { id: "A001", name: "Lisa", neighborhood: "Kallio", street: "Vaasankatu 5", transport: ["bus", "car", "walk"], maxTravel: 15, language: ["Russian", "English"], phone: "0401234501", dob: "2025-07-10", olderSiblingBirthMonth: "", worries: "New to Finland, wants Russian-speaking friends", hopes: "Weekly meetups", questions: "", amountOfChildren: 1, source: "Facebook" },
  { id: "A002", name: "Anni", neighborhood: "Kallio", street: "Helsinginkatu 12", transport: ["bus", "walk"], maxTravel: 10, language: ["Finnish", "English"], phone: "0401234502", dob: "2025-09-02", olderSiblingBirthMonth: "", worries: "", hopes: "Someone within walking distance", questions: "", amountOfChildren: 1, source: "Neuvola" },
  { id: "A003", name: "Sara", neighborhood: "Kallio", street: "Sturenkatu 20", transport: ["car"], maxTravel: 15, language: ["Finnish"], phone: "0401234503", dob: "2025-06-18", olderSiblingBirthMonth: "03.2022", worries: "", hopes: "", questions: "Can toddlers join too?", amountOfChildren: 2, source: "Friend" },
  { id: "A004", name: "Mia", neighborhood: "Töölö", street: "Runeberginkatu 8", transport: ["bus"], maxTravel: 20, language: ["Swedish", "English"], phone: "0401234504", dob: "2025-08-22", olderSiblingBirthMonth: "", worries: "First baby, feeling isolated", hopes: "", questions: "", amountOfChildren: 1, source: "Instagram" },
  { id: "A005", name: "Katri", neighborhood: "Töölö", street: "Topeliuksenkatu 15", transport: ["car", "walk"], maxTravel: 12, language: ["Finnish", "English"], phone: "0401234505", dob: "2025-07-30", olderSiblingBirthMonth: "", worries: "", hopes: "", questions: "", amountOfChildren: 1, source: "Neuvola" },
  { id: "A006", name: "Nour", neighborhood: "Töölö", street: "Mannerheimintie 60", transport: ["bus", "walk"], maxTravel: 15, language: ["Finnish", "Arabic"], phone: "0401234506", dob: "2025-09-14", olderSiblingBirthMonth: "", worries: "Language barrier", hopes: "Practice Finnish with other mums", questions: "", amountOfChildren: 1, source: "Facebook" },
  { id: "A007", name: "Elin", neighborhood: "Töölö", street: "Nordenskiöldinkatu 3", transport: ["car"], maxTravel: 20, language: ["Swedish", "Finnish"], phone: "0401234507", dob: "2025-06-05", olderSiblingBirthMonth: "", worries: "", hopes: "", questions: "", amountOfChildren: 1, source: "Friend" },
  { id: "A008", name: "Pia", neighborhood: "Espoo keskus", street: "Kirkkojärventie 4", transport: ["walk"], maxTravel: 8, language: ["Finnish"], phone: "0401234508", dob: "2025-11-01", olderSiblingBirthMonth: "", worries: "Far from other applicants so far", hopes: "", questions: "", amountOfChildren: 1, source: "Neuvola" },
  { id: "A009", name: "Reetta", neighborhood: "Espoo keskus", street: "Kamreerintie 2", transport: ["car", "walk"], maxTravel: 10, language: ["Finnish", "English"], phone: "0401234509", dob: "2025-10-20", olderSiblingBirthMonth: "", worries: "", hopes: "", questions: "", amountOfChildren: 1, source: "Facebook" },
  { id: "A010", name: "Johanna", neighborhood: "Kamppi", street: "Fredrikinkatu 30", transport: ["bus", "car"], maxTravel: 15, language: ["Finnish", "English"], phone: "0401234510", dob: "2025-08-08", olderSiblingBirthMonth: "", worries: "", hopes: "Coffee walks", questions: "", amountOfChildren: 1, source: "Instagram" },
  { id: "A011", name: "Camille", neighborhood: "Kamppi", street: "Runeberginkatu 2", transport: ["walk", "bus"], maxTravel: 12, language: ["French", "English"], phone: "0401234511", dob: "2025-07-25", olderSiblingBirthMonth: "", worries: "New in the city", hopes: "", questions: "", amountOfChildren: 1, source: "Facebook" },
  { id: "A012", name: "Ines", neighborhood: "Kruununhaka", street: "Kirkkokatu 10", transport: ["walk", "car"], maxTravel: 15, language: ["Finnish", "English"], phone: "0401234512", dob: "2025-09-28", olderSiblingBirthMonth: "", worries: "", hopes: "", questions: "", amountOfChildren: 1, source: "Neuvola" },
  { id: "A013", name: "Hanna", neighborhood: "Punavuori", street: "Iso Roobertinkatu 9", transport: ["bus", "walk"], maxTravel: 15, language: ["Finnish"], phone: "0401234513", dob: "2025-06-30", olderSiblingBirthMonth: "", worries: "", hopes: "", questions: "", amountOfChildren: 1, source: "Friend" },
  { id: "A014", name: "Amara", neighborhood: "Kallio", street: "Porthaninkatu 7", transport: ["bus", "car", "walk"], maxTravel: 15, language: ["English", "Swahili"], phone: "0401234514", dob: "2025-08-15", olderSiblingBirthMonth: "", worries: "", hopes: "", questions: "", amountOfChildren: 1, source: "Facebook" },
  { id: "A015", name: "Venla", neighborhood: "Kallio", street: "Aleksis Kiven katu 20", transport: ["car"], maxTravel: 25, language: ["Finnish", "English"], phone: "0401234515", dob: "2025-05-30", olderSiblingBirthMonth: "", worries: "", hopes: "", questions: "", amountOfChildren: 1, source: "Neuvola" },

  // --- Deliberately corrupted rows, simulating manual sheet edits ---
  { id: "A016", name: "Outi", neighborhood: "Kallio", street: "Fleminginkatu 9", transport: ["skateboard"], maxTravel: 15, language: ["Finnish"], phone: "0401234516", dob: "2025-07-01", worries: "", hopes: "", questions: "", amountOfChildren: 1, source: "Facebook" }, // unrecognized transport mode
  { id: "", name: "Tuula", neighborhood: "Töölö", street: "Museokatu 2", transport: ["car"], maxTravel: "many", language: ["Finnish"], phone: "123", dob: "32.13.2025", worries: "", hopes: "", questions: "", amountOfChildren: 1, source: "Neuvola" }, // missing id, bad maxTravel, bad phone, invalid date
  { id: "A018", name: "Riikka", neighborhood: "", street: "", transport: ["bus", "walk"], maxTravel: 12, language: [], phone: "0401234518", dob: "", worries: "", hopes: "", questions: "", amountOfChildren: 1, source: "Friend" }, // missing neighborhood/street/language/dob
];

const APPLICANTS = RAW_APPLICANTS.map((raw) => {
  const validated = Validation.normalizeApplicant(raw);
  return {
    ...raw, // keep informational-only fields (worries, hopes, questions, source, amountOfChildren)
    ...validated, // validated fields win where they overlap (id, name, transport, language, maxTravel, dob, phone, neighborhood, street)
    coords: jitter(NEIGHBORHOOD_COORDS[validated.neighborhood] || [60.1699, 24.9384]),
    geocodedReal: false, // flips true once the backend has geocoded the real address
    matchStatus: "unmatched",
    matchGroupId: null,
  };
});
