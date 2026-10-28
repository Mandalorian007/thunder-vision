import { connection } from "next/server";
import { ThunderVision } from "@/components/thunder-vision";
import { listSessions } from "@/server/tmux";

export default async function Home() {
  // tmux state is live; never prerender this page.
  await connection();
  return <ThunderVision initialSessions={await listSessions()} />;
}
