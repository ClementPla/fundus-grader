use crate::error::Result;
use crate::project_db::CaseRef;
use rand::seq::SliceRandom;
use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;
use rusqlite::{params, Connection};
use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};

/// Derive a per-(reader, phase) seed. Includes a hash of the reader's
/// name+surname so two readers on separate machines (both reader_id=1)
/// don't end up with identical orderings.
fn derive_seed(master: u64, reader_id: i64, reader_key: &str, phase: &str) -> u64 {
    let phase_n: u64 = if phase == "no_ai" { 1 } else { 2 };
    let mut h = std::collections::hash_map::DefaultHasher::new();
    reader_key.hash(&mut h);
    let name_hash = h.finish();
    master
        .wrapping_mul(2_654_435_761)
        .wrapping_add(name_hash.wrapping_mul(11_400_714_785_074_694_791))
        ^ (reader_id as u64).wrapping_mul(40_503)
        ^ phase_n
}

/// Build a stratified, round-robin-interleaved ordering of cases.
/// Calibration cases are placed first (in their natural order), then
/// the rest are stratified by (icdr, dme) and interleaved.
pub fn build_order(cases: &[CaseRef], seed: u64) -> Vec<i64> {
    let (calib, regular): (Vec<_>, Vec<_>) = cases.iter().partition(|c| c.is_calibration);

    let mut buckets: BTreeMap<(i64, i64), Vec<i64>> = BTreeMap::new();
    for c in &regular {
        buckets
            .entry((c.ref_icdr, c.ref_dme))
            .or_default()
            .push(c.id);
    }

    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    let mut bucket_lists: Vec<Vec<i64>> = buckets.into_values().collect();
    for b in &mut bucket_lists {
        b.shuffle(&mut rng);
    }
    // Round-robin order across buckets is itself shuffled so that strata don't always come in the same cycle.
    bucket_lists.shuffle(&mut rng);

    let mut order: Vec<i64> = calib.iter().map(|c| c.id).collect();
    let mut idx = 0usize;
    loop {
        let mut any = false;
        for b in &mut bucket_lists {
            if idx < b.len() {
                order.push(b[idx]);
                any = true;
            }
        }
        if !any {
            break;
        }
        idx += 1;
    }
    order
}

/// Generate assignments for a (reader, phase) if and only if none exist yet.
pub fn ensure_assignments(
    results: &Connection,
    project: &Connection,
    reader_id: i64,
    phase: &str,
    master_seed: u64,
) -> Result<()> {
    let n: i64 = results.query_row(
        "SELECT COUNT(*) FROM assignments WHERE reader_id = ?1 AND phase = ?2",
        params![reader_id, phase],
        |r| r.get(0),
    )?;
    if n > 0 {
        return Ok(());
    }
    // Look up reader's name+surname so the seed depends on identity, not
    // just the per-DB autoincrement reader_id.
    let (rname, rsurname): (String, String) = results.query_row(
        "SELECT name, surname FROM readers WHERE id = ?1",
        params![reader_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let reader_key = format!("{}|{}", rsurname.trim().to_lowercase(), rname.trim().to_lowercase());

    let cases = crate::project_db::list_cases(project)?;
    let seed = derive_seed(master_seed, reader_id, &reader_key, phase);
    let order = build_order(&cases, seed);
    let tx = results.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO assignments(reader_id,case_id,phase,order_index,status)
             VALUES(?1,?2,?3,?4,'pending')",
        )?;
        for (i, case_id) in order.iter().enumerate() {
            stmt.execute(params![reader_id, case_id, phase, i as i64])?;
        }
    }
    tx.commit()?;
    Ok(())
}
