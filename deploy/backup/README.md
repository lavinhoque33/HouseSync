# Encrypted backup and isolated recovery reference

**Template, not recovery certification.** This example uses an age-encrypted PostgreSQL logical dump and encrypted host `.env`/`deploy/` archive, then a read-only SSH pull to a separate NAS. It does not assert a backup is running, an alert was delivered, or populated records were restored. Before real records are entrusted to any host, choose an operator, numeric RPO/RTO, retention and key custody policy; exercise a populated restore, reconcile data and time a whole-host recovery. See [hosted boundaries](../README.md).

## Data flow and defaults

`housesync-backup.sh`, installed as a systemd oneshot plus [timer](housesync-backup.timer), defaults to source tree `/opt/housesync`, ciphertext directory `/var/backups/housesync`, public recipient file `/etc/housesync/backup-recipient`, Compose container `housesync_hosted_example-postgres-1`, database/user `housesync` and host retention `RETENTION_DAYS=90`. These are **example values**. The container default matches the example `COMPOSE_PROJECT_NAME` in `deploy/README.md`; set `CONTAINER` to `docker compose ... ps -q postgres`'s container ID or the actual container name if the operator chose a different project. Also review `SOURCE_DIR`, `BACKUP_DIR`, `RECIPIENT_FILE`, `DB`, `DB_USER`, `BACKUP_GROUP`, and retention in a systemd drop-in before enabling the service. Unit files have installed paths in `/opt/housesync`; use the documented directory or adjust units explicitly. Do not point a sample job at someone else's stack.

| Artifact | Contents and handling |
| --- | --- |
| `housesync-<UTC-date_time>.dump.age` | `pg_dump -Fc` of the configured PostgreSQL database, including financial/identity/session tables and Flyway history. |
| `housesync-config-<UTC-date>.tar.gz.age` | Untracked host `.env` and `deploy/` tree, including secret configuration. |
| `last-success`, `last-failure` | UTC timestamps, artifact names/byte sizes, or failure reason; retained success does not mean the latest run succeeded. |

The job creates mode-600 temporary plaintext files and removes them via an exit trap; ciphertext is staged under a hidden name before atomic rename, then made `640 root:backupreader` in a `750` directory for restricted pulling. A process crash, disk compromise, journal misconfiguration or root compromise still requires threat review; this script is not a guarantee that plaintext never reaches other storage. A rerun within the same UTC minute **replaces** the host artifact; the NAS script uses `--ignore-existing` and will *not* replace its already-pulled copy of the same name. Decide whether this collision is acceptable or schedule/artifact-name accordingly. Host retention removes matching artifacts older than the configured window; the NAS script does **not** prune its copy. Budget space and define NAS retention separately. The database volume itself, Caddy ACME volume, images and unrelated host files are not backed up.

## Encryption and host installation

Generate a new age identity **off the hosted machine and off the NAS**; store at least two independently recoverable protected copies of the private key. Losing every copy makes all old artifacts unreadable. Rotating the public recipient requires keeping the corresponding *old* private key until every old ciphertext copy is retired. The host stores only the public `age1...` recipient; a private key must never be committed, uploaded to either backup host, put in an issue, or printed in logs.

```sh
# On a trusted offline/operator machine, not the application host:
age-keygen -o housesync-backup.key
chmod 600 housesync-backup.key
# Transfer ONLY the displayed age1... public recipient to the reviewed host.
```

Install `age`, `rsync` (including `/usr/bin/rrsync`), Docker, and the reviewed project on the host. The commands below are a **sample** for a newly approved machine at `/opt/housesync`, not instructions to run on an existing installation. Replace the example public recipient; never paste an `AGE-SECRET-KEY-1...` value on the host.

```sh
sudo groupadd --system backupreader
sudo useradd --system --gid backupreader --home-dir /var/lib/backupreader --create-home --shell /bin/sh backupreader
sudo install -d -o root -g backupreader -m 750 /var/backups/housesync
sudo install -d -o backupreader -g backupreader -m 700 /var/lib/backupreader/.ssh
sudo install -d -m 755 /etc/housesync
printf '%s\n' 'age1...replace-with-public-recipient' | sudo tee /etc/housesync/backup-recipient >/dev/null
sudo chmod 644 /etc/housesync/backup-recipient
sudo install -m 755 /opt/housesync/deploy/backup/housesync-backup.sh /usr/local/sbin/housesync-backup
sudo install -m 644 /opt/housesync/deploy/backup/housesync-backup.service /etc/systemd/system/
sudo install -m 644 /opt/housesync/deploy/backup/housesync-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
```

Before enabling the timer, ensure the actual database container name and all source/destination paths match. Set overrides with `sudo systemctl edit housesync-backup.service`, e.g. `Environment=CONTAINER=<actual-postgres-container>` under `[Service]`, and inspect the effective unit. The default `03:30` timer uses the **host timezone**, adds up to five minutes jitter and catches up missed runs. Schedule the NAS pull *after* the worst-case job duration and confirm the NAS script's UTC freshness-hour assumption. The unit requires Docker, uses a one-hour timeout and emits journald logs; neither success markers nor journald send an alert by themselves.

```sh
sudo systemctl start housesync-backup.service
sudo journalctl -u housesync-backup.service -n 40 --no-pager
sudo cat /var/backups/housesync/last-success
# A failed run leaves the older success marker and writes last-failure.
sudo systemctl enable --now housesync-backup.timer
systemctl list-timers housesync-backup.timer --no-pager
```

A missing group makes artifacts root-only, preventing the NAS pull. A stopped container, missing recipient/config, failed `pg_dump`, invalid/empty archive or failed `age` aborts a run. Verify artifact freshness and encrypted copy off-host, not merely `systemctl active`.

## NAS read-only pull (DSM 7 example)

[`synology-pull-task.sh`](synology-pull-task.sh) is a real script with deliberately unresolved `VPS_HOST` and both pinned host keys; it aborts until configured. Its sample share `/volume1/housesync-example` is **not** a real backup destination. On a reviewed NAS create and secure that share (or update `DEST` in the script and matching path in [`synology-pull-task-stub.sh`](synology-pull-task-stub.sh)); verify `rsync`, SSH and DSM task PATH. The script creates its own SSH keypair as NAS root, exposes only the public key in the share, pins remote ED25519/ECDSA host keys and pulls ciphertext/markers into `daily/` with `--ignore-existing`. It never carries the age decryption identity. Verify host-key fingerprints through an independent trusted channel (not `ssh-keyscan` alone) before filling the pinned lines. Root on the NAS and host holds substantial power; review device and access security.

Create the DSM Scheduled Task as root, schedule it **after** the host job, and enable abnormal-termination email. Paste the short stub as its command and upload the configured full script into the matching share: DSM's command field is limited, so the stub is useful and retained. It checks file existence and shell syntax and exits nonzero when either fails. The first full-script run creates `housesync_pull.pub` but cannot authenticate yet. Install its verified public key on the host's restricted `backupreader` account with exactly the forced read-only command for the selected directory:

```text
restrict,command="/usr/bin/rrsync -ro /var/backups/housesync" ssh-ed25519 <NAS-generated-public-key> housesync-nas
```

Write that **single verified line** to `/var/lib/backupreader/.ssh/authorized_keys`, owned `backupreader:backupreader`, mode 600; the `.ssh` directory stays mode 700. The account uses `/bin/sh` so sshd can execute the forced command, but that key has no interactive shell/forwarding access. Rerun the NAS task; inspect `pull.log`, encrypted artifacts and `last-success`/`last-failure` off-host. The NAS's abnormal-exit email must be configured with a real alert receiver and tested by a *controlled* failed task; no running task or successful SMTP delivery is asserted here. A powered-off NAS or disabled task cannot alert, and full disks may be discovered only after a failure. The freshness guard compares newest filenames across UTC dates only after `STALE_CHECK_AFTER_UTC_HOUR`; review clock and schedule assumptions before trusting it. Rotate pull credentials by revoking the old authorized key before installing a new one; unexpected host-key changes require independent investigation before re-pinning.

## Restore drill: isolate, compare, clean up

Do **not** decrypt on the hosted machine, NAS or a production database. Select an off-host `.dump.age` and its matching configuration archive from the pull, check age decryption with an off-host private key, and keep plaintext on a restricted disposable workstation. Example commands below use a **throwaway isolated** PostgreSQL container and chosen downloaded artifact path; never reuse live port, volume or credentials.

```sh
chmod 600 housesync-backup.key
age -d -i housesync-backup.key -o restored.dump <downloaded-dump>.age
docker run -d --name housesync-restore-example -e POSTGRES_DB=housesync \
  -e POSTGRES_USER=housesync -e POSTGRES_PASSWORD=restore-only-not-live \
  -p 127.0.0.1:55432:5432 postgres:17-alpine
docker cp restored.dump housesync-restore-example:/tmp/restore.dump
docker exec housesync-restore-example pg_restore -U housesync -d housesync \
  --clean --if-exists --no-owner /tmp/restore.dump
docker exec housesync-restore-example psql -U housesync -d housesync \
  -c 'select version, success from flyway_schema_history order by installed_rank desc limit 1;'
docker exec housesync-restore-example psql -U housesync -d housesync \
  -c 'select count(*), max(occurred_on) from financial_transactions;'
```

Wait until PostgreSQL accepts connections before `docker cp`/restore; reject nonzero restore or schema errors. Compare reconciled users, households, accounts, transactions/refunds, allocations, repayments, budgets, categorization and replay associations to an authorized pre-backup snapshot (avoid exposing real row data in reports). Compare newest restored data date with backup timestamps; a dump's file age alone is not actual record RPO. For host replacement, decrypt the corresponding config archive offline with `age -d -i housesync-backup.key -o restored-config.tar.gz <downloaded-config>.age`; inspect its contents **before** extracting it to a restricted location. The archived `.env` contains historical credentials and may need deliberate rotation/reconciliation with the database. Never blindly overwrite an existing `.env`.

Clean up the disposable container and securely handle plaintext (`docker rm -f housesync-restore-example`; remove temporary dump/config files under your approved data-handling policy). Complete a second drill that restores the dump into a **separate Compose project**, with unused loopback `DB_PORT`, `SERVER_PORT` and `WEB_PORT` values, and exercises authenticated household/ledger/Insights journeys. Measure whole-host recovery and test notification delivery, not just `pg_restore` exit status. The scripts alone do not establish whole-host or off-host recovery. Choose retention and operational ownership before making data-protection or recovery promises.
