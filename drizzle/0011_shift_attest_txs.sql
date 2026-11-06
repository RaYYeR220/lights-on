-- shifts.attest_tx held every multiAttest tx of a shift as one comma-joined string (rendered as one broken link and
-- appended with a read-modify-write); it becomes an array, split from the old value, appended in single statements.
ALTER TABLE "shifts" ALTER COLUMN "attest_tx" SET DATA TYPE text[] USING (
  CASE WHEN "attest_tx" IS NULL OR btrim("attest_tx") = '' THEN NULL
       ELSE array_remove(string_to_array(replace("attest_tx", ' ', ''), ','), '') END
);
