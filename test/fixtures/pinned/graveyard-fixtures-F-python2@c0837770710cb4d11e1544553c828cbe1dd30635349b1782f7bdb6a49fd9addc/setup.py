# -*- coding: utf-8 -*-
from distutils.core import setup

if __name__ == "__main__":
    print "building f-python2"

setup(
    name="f-python2",
    version="1.0.0",
    description="Test fixture for Python 2 to 3 modernization.",
    packages=["legacy"],
    python_requires=">=3.9",
)
