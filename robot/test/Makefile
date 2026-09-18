CXXFLAGS ?= -std=c++11 -Wall -Wextra -Werror -O1 -I../include

test_protocol: test_protocol.cpp ../src/vex_protocol.cpp ../include/vex_protocol.h
	$(CXX) $(CXXFLAGS) -o $@ test_protocol.cpp ../src/vex_protocol.cpp

run: test_protocol
	./test_protocol

clean:
	rm -f test_protocol

.PHONY: run clean
