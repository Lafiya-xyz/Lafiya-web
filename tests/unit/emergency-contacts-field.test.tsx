/**
 * Tests for app/(auth)/profile/emergency-contacts-field.tsx
 *
 * Covers: rendering initial state, adding/removing/editing contacts,
 * multi-contact scenarios, and the JSON hidden input.
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { EmergencyContactsField } from "@/app/(auth)/profile/emergency-contacts-field";
import type { EmergencyContact } from "@/lib/supabase/types";

const ALICE: EmergencyContact = { name: "Alice", phone: "080-0001", relationship: "Sister" };
const BOB: EmergencyContact = { name: "Bob", phone: "080-0002", relationship: "Brother" };
const CAROL: EmergencyContact = { name: "Carol", phone: "080-0003", relationship: "Mother" };

// ---- helpers ----

function getHiddenJson(): EmergencyContact[] {
  const input = document.querySelector(
    'input[name="emergencyContactsJson"]',
  ) as HTMLInputElement;
  return JSON.parse(input.value) as EmergencyContact[];
}

function nameInputs() {
  return screen.getAllByPlaceholderText("Name") as HTMLInputElement[];
}
function phoneInputs() {
  return screen.getAllByPlaceholderText("Phone") as HTMLInputElement[];
}
function relationshipInputs() {
  return screen.getAllByPlaceholderText("Relationship") as HTMLInputElement[];
}
function removeButtons() {
  return screen.getAllByRole("button", {
    name: /remove emergency contact/i,
  }) as HTMLButtonElement[];
}

// ---- empty state ----

describe("EmergencyContactsField — empty state", () => {
  it("renders one empty row when initialValues is empty", () => {
    render(<EmergencyContactsField initialValues={[]} />);
    expect(nameInputs().length).toBe(1);
    expect(nameInputs()[0].value).toBe("");
    expect(phoneInputs()[0].value).toBe("");
    expect(relationshipInputs()[0].value).toBe("");
  });

  it("disables the remove button on the sole row", () => {
    render(<EmergencyContactsField initialValues={[]} />);
    const [btn] = removeButtons();
    expect(btn).toBeDisabled();
  });
});

// ---- initial values ----

describe("EmergencyContactsField — initial values", () => {
  it("renders provided contacts with correct values", () => {
    render(<EmergencyContactsField initialValues={[ALICE, BOB]} />);
    const names = nameInputs();
    expect(names[0].value).toBe("Alice");
    expect(names[1].value).toBe("Bob");
    const phones = phoneInputs();
    expect(phones[0].value).toBe("080-0001");
    expect(phones[1].value).toBe("080-0002");
  });

  it("hidden JSON input reflects the initial contacts", () => {
    render(<EmergencyContactsField initialValues={[ALICE]} />);
    const data = getHiddenJson();
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("Alice");
  });
});

// ---- adding a contact ----

describe("EmergencyContactsField — adding contacts", () => {
  it("adds a new empty row when '+ Add contact' is clicked", () => {
    render(<EmergencyContactsField initialValues={[ALICE]} />);
    fireEvent.click(screen.getByRole("button", { name: /add contact/i }));
    expect(nameInputs().length).toBe(2);
    expect(nameInputs()[1].value).toBe("");
  });

  it("disables '+ Add contact' when 3 contacts exist", () => {
    render(<EmergencyContactsField initialValues={[ALICE, BOB, CAROL]} />);
    const addBtn = screen.getByRole("button", { name: /add contact/i });
    expect(addBtn).toBeDisabled();
  });

  it("hidden JSON updates after adding a contact", () => {
    render(<EmergencyContactsField initialValues={[ALICE]} />);
    fireEvent.click(screen.getByRole("button", { name: /add contact/i }));
    const data = getHiddenJson();
    expect(data).toHaveLength(2);
  });
});

// ---- editing a contact ----

describe("EmergencyContactsField — editing contacts", () => {
  it("updates name of a specific contact without touching the other", () => {
    render(<EmergencyContactsField initialValues={[ALICE, BOB]} />);
    const names = nameInputs();
    fireEvent.change(names[0], { target: { value: "Alicia" } });

    const updatedNames = nameInputs();
    expect(updatedNames[0].value).toBe("Alicia");
    expect(updatedNames[1].value).toBe("Bob"); // untouched
  });

  it("updates phone of the second contact independently", () => {
    render(<EmergencyContactsField initialValues={[ALICE, BOB]} />);
    const phones = phoneInputs();
    fireEvent.change(phones[1], { target: { value: "090-9999" } });

    expect(phoneInputs()[0].value).toBe("080-0001"); // Alice untouched
    expect(phoneInputs()[1].value).toBe("090-9999");
  });

  it("reflects edits in the hidden JSON input", () => {
    render(<EmergencyContactsField initialValues={[ALICE]} />);
    fireEvent.change(nameInputs()[0], { target: { value: "Ali" } });
    const data = getHiddenJson();
    expect(data[0].name).toBe("Ali");
  });
});

// ---- removing a contact ----

describe("EmergencyContactsField — removing contacts", () => {
  it("enables remove buttons when more than one contact exists", () => {
    render(<EmergencyContactsField initialValues={[ALICE, BOB]} />);
    removeButtons().forEach((btn) => expect(btn).not.toBeDisabled());
  });

  it("removes the targeted contact, leaving the others intact", () => {
    render(<EmergencyContactsField initialValues={[ALICE, BOB, CAROL]} />);
    // Remove the second contact (Bob).
    fireEvent.click(removeButtons()[1]);

    const names = nameInputs();
    expect(names).toHaveLength(2);
    expect(names[0].value).toBe("Alice");
    expect(names[1].value).toBe("Carol");
  });

  it("removes the first contact without affecting the rest", () => {
    render(<EmergencyContactsField initialValues={[ALICE, BOB]} />);
    fireEvent.click(removeButtons()[0]);

    expect(nameInputs()).toHaveLength(1);
    expect(nameInputs()[0].value).toBe("Bob");
  });

  it("disables remove after reducing to one contact", () => {
    render(<EmergencyContactsField initialValues={[ALICE, BOB]} />);
    fireEvent.click(removeButtons()[0]);
    expect(removeButtons()[0]).toBeDisabled();
  });

  it("hidden JSON reflects the removal", () => {
    render(<EmergencyContactsField initialValues={[ALICE, BOB]} />);
    fireEvent.click(removeButtons()[0]);
    const data = getHiddenJson();
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("Bob");
  });
});

// ---- error prop ----

describe("EmergencyContactsField — error display", () => {
  it("renders an error message when error prop is provided", () => {
    render(
      <EmergencyContactsField
        initialValues={[]}
        error="At least one contact is required."
      />,
    );
    expect(
      screen.getByText(/at least one contact is required/i),
    ).toBeInTheDocument();
  });

  it("does not render an error element when error prop is absent", () => {
    render(<EmergencyContactsField initialValues={[]} />);
    expect(
      screen.queryByText(/error/i),
    ).toBeNull();
  });
});
