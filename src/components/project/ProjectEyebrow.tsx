import Link from "next/link";
import { SOURCE_LABEL } from "@/components/tower/model";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Where the project comes from (community-added ones say so plainly) and whether its founder has claimed it. */
export function ProjectEyebrow({ source, communityAdded, claimedBy }: { source: string; communityAdded: boolean; claimedBy: string | null }) {
  return (
    <p className="eyebrow rv">
      {communityAdded ? (
        <span className="tag" data-testid="community-label">
          <i className="sw sw-none" aria-hidden="true" />
          Community-added · unverified
        </span>
      ) : (
        <span>{SOURCE_LABEL[source] ?? source}</span>
      )}
      {claimedBy ? <span>Claimed by its founder {short(claimedBy)}</span> : null}
      <Link className="ul" href="/">
        Back to the building
      </Link>
    </p>
  );
}
