import Link from "next/link";
export default function Home() {
  return (
    <section className="card">
      <p className="eyebrow">OD & permission letters</p>
      <h1>Approvals in the right order.</h1>
      <p>
        Prepare a request, route it through Student → Faculty Advisor → HoD, and
        keep a verifiable record.
      </p>
      <Link className="button" href="/sign-in">
        Open your workspace
      </Link>
    </section>
  );
}
