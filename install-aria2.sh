#!/bin/bash

# Install aria2c - required for torrent downloading

echo "Installing aria2c..."

if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    echo "Installing on macOS..."
    if command -v brew &> /dev/null; then
        brew install aria2
    else
        echo "Homebrew not found. Please install Homebrew first:"
        echo "https://brew.sh/"
        exit 1
    fi
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    echo "Installing on Linux..."
    if command -v apt &> /dev/null; then
        sudo apt update
        sudo apt install aria2
    elif command -v yum &> /dev/null; then
        sudo yum install aria2
    else
        echo "No supported package manager found. Please install aria2 manually."
        exit 1
    fi
else
    echo "Unsupported OS. Please install aria2c manually."
    exit 1
fi

echo "aria2c installation complete!"
echo "Verifying installation..."
aria2c --version