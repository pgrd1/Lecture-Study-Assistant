// Deliberately uncooperative CPU fixture, killed only by its test-owned Worker.terminate().
while (true) {
  Math.sqrt(123);
}
