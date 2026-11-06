import type { Metadata } from "next";
import { getStudyView } from "@/lib/views/study";
import { StudyBody } from "@/components/study/StudyBody";

export const metadata: Metadata = {
  title: "Study · Lights On",
  description:
    "What small onchain projects ship after the hackathon, rebuilt from public repos, live apps and contracts: the numbers behind Lights On.",
};

/** Static: the results JSON is imported at build time, so nothing here reads the database. */
export default function StudyPage() {
  return <StudyBody view={getStudyView()} />;
}
