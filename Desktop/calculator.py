#!/usr/bin/env python3

"""
Simple calculator script.
Usage: python calculator.py <operation> <num1> <num2>
Operations: add, sub, mul, div
"""

import sys

def add(a, b):
    return a + b

def sub(a, b):
    return a - b

def mul(a, b):
    return a * b

def div(a, b):
    if b == 0:
        raise ValueError("Division by zero")
    return a / b

if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: python calculator.py <operation> <num1> <num2>")
        sys.exit(1)
    op = sys.argv[1]
    try:
        num1 = float(sys.argv[2])
        num2 = float(sys.argv[3])
    except ValueError:
        print("Please provide numeric values for num1 and num2")
        sys.exit(1)

    if op == "add":
        result = add(num1, num2)
    elif op == "sub":
        result = sub(num1, num2)
    elif op == "mul":
        result = mul(num1, num2)
    elif op == "div":
        try:
            result = div(num1, num2)
        except ValueError as e:
            print(e)
            sys.exit(1)
    else:
        print("Unsupported operation. Use add, sub, mul, or div.")
        sys.exit(1)

    print(f"Result: {result}")
