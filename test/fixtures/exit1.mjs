// A child that fails the way a crashing picker fails: writes nothing, exits 1.
process.stderr.write("deliberate failure\n");
process.exit(1);
