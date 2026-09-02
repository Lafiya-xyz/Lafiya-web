import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { EmergencyContactsField } from "../emergency-contacts-field";
import { profileFormSchema } from "@/lib/validation/profile";

const EMPTY_CONTACT = { name: "", phone: "", relationship: "" };

describe("EmergencyContactsField — client-side limit enforcement", () => {
  it("shows a limit-reached message when the maximum number of contacts is displayed", () => {
    render(
      <EmergencyContactsField
        initialValues={[
          { name: "A", phone: "+2348011111111", relationship: "Sibling" },
          { name: "B", phone: "+2348022222222", relationship: "Parent" },
          { name: "C", phone: "+2348033333333", relationship: "Spouse" },
        ]}
        error={undefined}
      />,
    );

    expect(
      screen.getByText(/Maximum of 3 emergency contacts reached/i),
    ).toBeInTheDocument();
  });

  it("does not show the limit message when contacts are below the maximum", () => {
    render(
      <EmergencyContactsField
        initialValues={[EMPTY_CONTACT]}
        error={undefined}
      />,
    );

    expect(
      screen.queryByText(/Maximum of 3 emergency contacts reached/i),
    ).not.toBeInTheDocument();
  });

  it("disables the add-contact button at the limit", () => {
    render(
      <EmergencyContactsField
        initialValues={[
          { name: "A", phone: "+2348011111111", relationship: "Sibling" },
          { name: "B", phone: "+2348022222222", relationship: "Parent" },
          { name: "C", phone: "+2348033333333", relationship: "Spouse" },
        ]}
        error={undefined}
      />,
    );

    const addButton = screen.getByRole("button", { name: /\+ Add contact/i });
    expect(addButton).toBeDisabled();
  });

  it("shows the limit message only after reaching MAX_CONTACTS via user interaction", async () => {
    const user = userEvent.setup();
    render(
      <EmergencyContactsField
        initialValues={[
          { name: "A", phone: "+2348011111111", relationship: "Sibling" },
          { name: "B", phone: "+2348022222222", relationship: "Parent" },
        ]}
        error={undefined}
      />,
    );

    // Initially two contacts — no limit message.
    expect(
      screen.queryByText(/Maximum of 3 emergency contacts reached/i),
    ).not.toBeInTheDocument();

    // Add a third contact.
    await user.click(screen.getByRole("button", { name: /\+ Add contact/i }));

    // Now at the limit — message should appear.
    expect(
      screen.getByText(/Maximum of 3 emergency contacts reached/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /\+ Add contact/i }),
    ).toBeDisabled();
  });
});

describe("profileFormSchema — server-side limit enforcement", () => {
  const validContact = {
    name: "Halima Yusuf",
    phone: "+2348012345678",
    relationship: "Mother",
  };

  it("accepts exactly 3 emergency contacts", () => {
    const result = profileFormSchema.safeParse({
      name: "Test Patient",
      bloodGroup: "O+",
      genotype: "AA",
      allergies: [],
      medications: [],
      chronicConditions: [],
      emergencyContacts: [validContact, validContact, validContact],
    });
    expect(result.success).toBe(true);
  });

  it("rejects 4 or more emergency contacts with a clear message", () => {
    const result = profileFormSchema.safeParse({
      name: "Test Patient",
      bloodGroup: "O+",
      genotype: "AA",
      allergies: [],
      medications: [],
      chronicConditions: [],
      emergencyContacts: [
        validContact,
        validContact,
        validContact,
        validContact,
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.path.includes("emergencyContacts"),
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/3 emergency contacts/i);
    }
  });

  it("rejects 5 contacts just as definitively as 4", () => {
    const result = profileFormSchema.safeParse({
      name: "Test Patient",
      bloodGroup: "O+",
      genotype: "AA",
      allergies: [],
      medications: [],
      chronicConditions: [],
      emergencyContacts: Array(5).fill(validContact),
    });
    expect(result.success).toBe(false);
  });
});
