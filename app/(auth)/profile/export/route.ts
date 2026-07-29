import { NextResponse } from "next/server";
import { exportMyProfileData } from "../actions";

export async function GET() {
  const result = await exportMyProfileData();

  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 401 });
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