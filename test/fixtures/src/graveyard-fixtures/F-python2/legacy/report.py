# -*- coding: utf-8 -*-
"""Build report for the f-python2 fixture."""
import sys


def summarize(items):
    total = 0
    for name, value in items.iteritems():
        total += value
    if total > 0:
        print "total:", total
    else:
        print "no items"
    return total


def main():
    try:
        summarize({"a": 1, "b": 2})
    except ValueError, err:
        print >>sys.stderr, "failed:", err


if __name__ == "__main__":
    main()
