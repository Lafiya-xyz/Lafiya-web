import { describe, expect, it } from "vitest";

import { profileFormSchema } from "./profile";

const validProfile = {
  name: "Amina Yusuf",
  dateOfBirth: "1998-03-14",
  language: "Hausa",
  bloodGroup: "O+" as const,
  genotype: "AS" as const,
  allergies: ["Penicillin"],
  medications: ["Insulin"],
  chronicConditions: ["Asthma"],
  emergencyContacts: [
    { name: "Halima Yusuf", phone: "+2348012345678", relationship: "Mother" },
  ],
};

describe("profileFormSchema", () => {
  it("accepts a fully-populated valid profile", () => {
    const result = profileFormSchema.safeParse(validProfile);
    expect(result.success).toBe(true);
  });

  it("accepts a minimal profile with only required fields", () => {
    const result = profileFormSchema.safeParse({
      name: "Amina Yusuf",
      bloodGroup: "unknown",
      genotype: "unknown",
      allergies: [],
      medications: [],
      chronicConditions: [],
      emergencyContacts: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing name", () => {
    const result = profileFormSchema.safeParse({
      ...validProfile,
      name: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid date of birth", () => {
    const result = profileFormSchema.safeParse({
      ...validProfile,
      dateOfBirth: "not-a-date",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a blood group outside the enum", () => {
    const result = profileFormSchema.safeParse({
      ...validProfile,
      bloodGroup: "Z+",
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than 3 emergency contacts", () => {
    const result = profileFormSchema.safeParse({
      ...validProfile,
      emergencyContacts: [
        { name: "A", phone: "1", relationship: "x" },
        { name: "B", phone: "2", relationship: "x" },
        { name: "C", phone: "3", relationship: "x" },
        { name: "D", phone: "4", relationship: "x" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an emergency contact missing a required field", () => {
    const result = profileFormSchema.safeParse({
      ...validProfile,
      emergencyContacts: [
        { name: "Halima Yusuf", phone: "", relationship: "Mother" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid emergency contact phone numbers in various formats", () => {
    const formats = [
      "+2348012345678", // Nigerian international
      "08012345678", // Nigerian local
      "0803 123 4567", // Nigerian local with spaces
      "+14155552671", // US international
    ];
    for (const phone of formats) {
      const result = profileFormSchema.safeParse({
        ...validProfile,
        emergencyContacts: [
          { name: "Halima Yusuf", phone, relationship: "Mother" },
        ],
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid emergency contact phone numbers", () => {
    const invalidPhones = ["123", "not-a-phone", "080", "++2348012345678"];
    for (const phone of invalidPhones) {
      const result = profileFormSchema.safeParse({
        ...validProfile,
        emergencyContacts: [
          { name: "Halima Yusuf", phone, relationship: "Mother" },
        ],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const error = result.error.issues.find((e) => e.path.includes("phone"));
        expect(error?.message).toBe(
          "This doesn't look like a valid phone number",
        );
      }
    }
  });
});
