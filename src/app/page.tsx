import { connection } from "next/server";
import { ThunderVision } from "@/components/thunder-vision";
import { listSessions } from "@/server/tmux";
import { summaries, WORKFLOW_DOCS } from "@/server/workflows";

export default async function Home() {
  // tmux state is live; never prerender this page.
  await connection();
  return (
    <ThunderVision
      initialSessions={await listSessions()}
      initialWorkflows={summaries()}
      workflowDocs={WORKFLOW_DOCS}
    />
  );
}
