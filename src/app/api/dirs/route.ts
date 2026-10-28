import { listDirs } from "@/server/repos";

export async function GET() {
  return Response.json(await listDirs(), {
    headers: { "Cache-Control": "no-store" },
  });
}
