import { describe, expect, it } from "vitest";

import { profileFormSchema, RELATIONSHIP_TYPES } from "./profile";

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
        { name: "A", phone: "+2348012345601", relationship: "Parent" },
        { name: "B", phone: "+2348012345602", relationship: "Parent" },
        { name: "C", phone: "+2348012345603", relationship: "Parent" },
        { name: "D", phone: "+2348012345604", relationship: "Parent" },
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

  describe("relationship field validation", () => {
    it("accepts all predefined relationship types", () => {
      for (const relationship of RELATIONSHIP_TYPES) {
        const result = profileFormSchema.safeParse({
          ...validProfile,
          emergencyContacts: [
            { name: "John Doe", phone: "+2348012345678", relationship },
          ],
        });
        expect(result.success).toBe(true);
      }
    });

    it("accepts custom/free-text relationship values not in the predefined list", () => {
      const customRelationships = [
        "Neighbor",
        "Employer",
        "Ex-spouse",
        "Foster parent",
        "God parent",
      ];
      for (const relationship of customRelationships) {
        const result = profileFormSchema.safeParse({
          ...validProfile,
          emergencyContacts: [
            { name: "John Doe", phone: "+2348012345678", relationship },
          ],
        });
        expect(result.success).toBe(true);
      }
    });

    it("rejects empty relationship field", () => {
      const result = profileFormSchema.safeParse({
        ...validProfile,
        emergencyContacts: [
          { name: "John Doe", phone: "+2348012345678", relationship: "" },
        ],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const error = result.error.issues.find((e) => e.path.includes("relationship"));
        expect(error?.message).toBe("Relationship is required");
      }
    });

    it("rejects relationship field exceeding max length", () => {
      const result = profileFormSchema.safeParse({
        ...validProfile,
        emergencyContacts: [
          {
            name: "John Doe",
            phone: "+2348012345678",
            relationship: "a".repeat(51),
          },
        ],
      });
      expect(result.success).toBe(false);
    });

    it("trims whitespace from relationship field", () => {
      const result = profileFormSchema.safeParse({
        ...validProfile,
        emergencyContacts: [
          {
            name: "John Doe",
            phone: "+2348012345678",
            relationship: "  Parent  ",
          },
        ],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.emergencyContacts[0].relationship).toBe("Parent");
      }
    });

    it("preserves existing free-text values that are not in the predefined list (backward compatibility)", () => {
      const existingFreeTextValue = "Medical Doctor";
      const result = profileFormSchema.safeParse({
        ...validProfile,
        emergencyContacts: [
          {
            name: "John Doe",
            phone: "+2348012345678",
            relationship: existingFreeTextValue,
          },
        ],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.emergencyContacts[0].relationship).toBe(
          existingFreeTextValue,
        );
      }
    });

    it("accepts 'Other' option which suggests free text input for non-standard relationships", () => {
      const result = profileFormSchema.safeParse({
        ...validProfile,
        emergencyContacts: [
          { name: "John Doe", phone: "+2348012345678", relationship: "Other" },
        ],
      });
      expect(result.success).toBe(true);
    });
  });
});
