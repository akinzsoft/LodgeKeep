-- Runs once, on first initialisation of an empty MySQL data volume.
--
-- Two databases, not one. The test schema is dropped and rebuilt from
-- migrations on every test run, so it must be a separate database from
-- development data — and its name must contain "test", which is the guard
-- backend/knexfile.js and TESTING.md's tests/helpers/global-setup.js both
-- enforce before they touch anything.

CREATE DATABASE IF NOT EXISTS `lodgekeep_dev`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE DATABASE IF NOT EXISTS `lodgekeep_test`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- The app user needs full rights on both: migrations create and drop tables,
-- and the test suite rebuilds its whole schema.
GRANT ALL PRIVILEGES ON `lodgekeep_dev`.*  TO 'lodgekeep'@'%';
GRANT ALL PRIVILEGES ON `lodgekeep_test`.* TO 'lodgekeep'@'%';

FLUSH PRIVILEGES;
