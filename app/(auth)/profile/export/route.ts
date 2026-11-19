import { NextResponse } from "next/server";
import { STEP_UP_REQUIRED } from "@/lib/auth/assurance";
import {
  buildExportBundle,
  buildIpsComposition,
} from "@/lib/phi/export-bundle";
import { exportMyProfileData } from "../actions";

// Schema documentation: docs/data-export-schema.md — update that file whenever
// the shape returned by exportMyProfileData() changes.
//
// Issue #972: this route no longer reads or maps PHI columns directly. The
// export-bundle projection in lib/phi/ is the only module allowed to touch
// PHI tables; this route just serialises the projection it returns.
export async function GET(request: Request) {
  const result = await exportMyProfileData();

  if ("error" in result) {
    // Issue #522: this is a plain browser navigation (a download link), not
    // a fetch a client component could retry in place -- redirect to the
    // step-up challenge page instead, which re-navigates back here (this
    // exact URL) once the session is verified to aal2, completing the
    // export without the user re-entering anything (there was never any
    // form data to re-enter for a no-argument export in the first place).
    if (result.code === STEP_UP_REQUIRED) {
      const next = encodeURIComponent(new URL(request.url).pathname);
      return NextResponse.redirect(
        new URL(`/profile/verify-step-up?next=${next}`, request.url),
      );
    }
    return NextResponse.json({ error: result.error }, { status: 401 });
  }

  const format = new URL(request.url).searchParams.get("format");

  if (format === "ips") {
    const bundle = buildExportBundle(result.data, "ips");

    const ipsFilename = `lafiya-ips-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;

    return new NextResponse(JSON.stringify(bundle, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/fhir+json",
        "Content-Disposition": `attachment; filename="${ipsFilename}"`,
      },
    });
  }

  const filename = `lafiya-profile-export-${new Date()
    .toISOString()
    .slice(0, 10)}.json`;

  return new NextResponse(JSON.stringify(result.data, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
