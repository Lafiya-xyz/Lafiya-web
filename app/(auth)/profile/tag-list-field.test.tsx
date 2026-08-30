import { fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { isDuplicateTag, normalizeTagValue, TagListField } from "./tag-list-field";

describe("normalizeTagValue", () => {
  it("trims leading and trailing whitespace", () => {
    expect(normalizeTagValue(" Penicillin ")).toBe("Penicillin");
    expect(normalizeTagValue("Penicillin")).toBe("Penicillin");
  });
});

describe("isDuplicateTag", () => {
  it("treats ' Penicillin ' and 'Penicillin' as the same tag after trimming", () => {
    const values = [" Penicillin ", "Penicillin"];
    expect(isDuplicateTag(values, 0)).toBe(true);
    expect(isDuplicateTag(values, 1)).toBe(true);
  });

  it("does not flag distinct, non-empty values as duplicates", () => {
    const values = ["Penicillin", "Ibuprofen"];
    expect(isDuplicateTag(values, 0)).toBe(false);
    expect(isDuplicateTag(values, 1)).toBe(false);
  });

  it("ignores empty entries when checking for duplicates", () => {
    const values = ["", ""];
    expect(isDuplicateTag(values, 0)).toBe(false);
  });
});

describe("TagListField", () => {
  it("stores and displays a value trimmed after the input loses focus", () => {
    render(
      <TagListField
        name="allergies"
        label="Allergies"
        initialValues={["Penicillin"]}
      />,
    );

    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: " Penicillin " } });
    fireEvent.blur(input);

    expect(input.value).toBe("Penicillin");
  });

  it("flags a duplicate once a trimmed entry matches an existing tag", () => {
    render(
      <TagListField
        name="allergies"
        label="Allergies"
        initialValues={["Penicillin", "Ibuprofen"]}
      />,
    );

    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    fireEvent.change(inputs[1], { target: { value: " Penicillin " } });
    fireEvent.blur(inputs[1]);

    expect(inputs[1].value).toBe("Penicillin");
    expect(screen.getAllByText("Duplicate")).toHaveLength(2);
  });
});
